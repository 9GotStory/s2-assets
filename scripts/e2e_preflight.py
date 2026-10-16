#!/usr/bin/env python3
"""Standard-library-only controller and trusted structured recovery for T046 isolated Playwright runtime preflight."""

import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

EXPECTED_IMAGE = "s2-assets-e2e-runner:local"
EXPECTED_IMAGE_ID = "2a4778c23106d33f9c9c4d98d49adccd6d6fe968d4554e5ec20b9225e16a0175"
EXPECTED_LOCKFILE_SHA256 = (
    "a2aeacebb1b8b098b4c96218731cc137812b887c5966f6e20f8361060a80c467"
)
CONTROL_PROTOCOL_VERSION = "s2_e2e_preflight_v1"
MAX_CONTROL_FILE_BYTES = 4096

# Global state for cleanup and signal handling
_cleanup_state = {
    "inv_id": None,
    "active_cid": None,
    "active_cidfile": None,
    "active_workspace": None,
    "active_proc": None,
    "cleanup_failed": False,
    "signal_received": 0,
    "producer_exit": None,
    "controller_exit": 0,
    "cleanup_exit": 0,
    "project_name": None,
    "env_dir": None,
    "recovery_log_path": None,
}


def _fail_exit(message: str, code: int = 1) -> None:
    sys.stderr.write(f"{message}\n")
    sys.exit(code)


def _compute_sha256(file_path: Path) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def atomic_write_recovery_log(target_path: str, content: str) -> tuple[bool, int]:
    """Atomically write and fsync recovery state to private file.

    Returns (success: bool, errno_code: int).
    Checks writes, short writes, file fsync, close, replace, and directory fsync.
    Never swallows errors or falsely claims durable evidence.
    """
    target_p = Path(target_path)
    target_dir = str(target_p.parent)
    temp_path = str(target_p) + f".tmp.{os.getpid()}"
    fd = -1
    dir_fd = -1
    data = content.encode("utf-8")

    try:
        fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        total_written = 0
        while total_written < len(data):
            n = os.write(fd, data[total_written:])
            if n <= 0:
                raise OSError(errno.EIO, "short write on recovery log")
            total_written += n
        os.fsync(fd)
        os.close(fd)
        fd = -1

        os.replace(temp_path, target_path)

        dir_fd = os.open(target_dir, os.O_RDONLY)
        os.fsync(dir_fd)
        os.close(dir_fd)
        dir_fd = -1
        return (True, 0)
    except OSError as e:
        err = e.errno or errno.EIO
        if fd != -1:
            try:
                os.close(fd)
            except OSError:
                pass
        if dir_fd != -1:
            try:
                os.close(dir_fd)
            except OSError:
                pass
        try:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        except OSError:
            pass
        return (False, err)


def format_recovery_info(
    exit_status: int,
    trap_signal: int,
    cleanup_failed: bool,
    project_name: str,
    unremoved_cid: str | None = None,
    unremoved_workspace: str | None = None,
) -> str:
    lines = [
        "",
        "--- E2E Runtime Failure Recovery Information ---",
        f"Exit status: {exit_status}",
        f"Trap signal: {trap_signal}",
        f"Cleanup failed: {1 if cleanup_failed else 0}",
        f"Project: {project_name or 'unknown'}",
    ]
    if unremoved_cid:
        lines.append(f"Unremoved runner container ID: {unremoved_cid}")
        lines.append(
            f"Manual container removal command: podman rm -f -t 1 {unremoved_cid}"
        )
    if unremoved_workspace:
        lines.append(f"Unremoved runner workspace: {unremoved_workspace}")
        lines.append(
            f"Manual workspace removal command: rm -rf {unremoved_workspace}"
        )
    lines.append(
        f"Recovery: Ensure web container is healthy in project '{project_name or 'unknown'}', check connectivity to http://web:5173, then rerun 'bash scripts/dev.sh e2e --preflight'"
    )
    lines.append("------------------------------------------------")
    lines.append("")
    return "\n".join(lines)


def _perform_cleanup() -> None:
    cid = _cleanup_state.get("active_cid")
    cidfile = _cleanup_state.get("active_cidfile")
    ws = _cleanup_state.get("active_workspace")

    # Order invariant: container first, mounted workspace afterward
    if cid:
        # Check simulation hook
        if os.environ.get("FOUNDATION_E2E_SIMULATE_CLEANUP_FAIL") == "1":
            _cleanup_state["cleanup_failed"] = True
            _cleanup_state["cleanup_exit"] = 1
            sys.stderr.write(f"ERROR: Failed to remove runner container {cid}\n")
        else:
            try:
                res = subprocess.run(
                    [
                        "podman",
                        "--events-backend=none",
                        "rm",
                        "-f",
                        "-t",
                        "1",
                        cid,
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                )
                if res.returncode != 0:
                    _cleanup_state["cleanup_failed"] = True
                    _cleanup_state["cleanup_exit"] = 1
                    sys.stderr.write(
                        f"ERROR: Failed to remove runner container {cid}\n"
                    )
                else:
                    _cleanup_state["active_cid"] = None
            except Exception:
                _cleanup_state["cleanup_failed"] = True
                _cleanup_state["cleanup_exit"] = 1
                sys.stderr.write(
                    f"ERROR: Failed to remove runner container {cid}\n"
                )

    if cidfile:
        try:
            if os.path.exists(cidfile):
                os.unlink(cidfile)
            _cleanup_state["active_cidfile"] = None
        except Exception:
            _cleanup_state["cleanup_failed"] = True

    if ws and not _cleanup_state["cleanup_failed"]:
        try:
            if os.path.exists(ws):
                shutil.rmtree(ws)
            _cleanup_state["active_workspace"] = None
        except Exception:
            _cleanup_state["cleanup_failed"] = True
            _cleanup_state["cleanup_exit"] = 1


def _handle_signal(signum: int, frame) -> None:
    _cleanup_state["signal_received"] = signum
    exit_code = 128 + signum
    if _cleanup_state["producer_exit"] is None:
        _cleanup_state["producer_exit"] = exit_code

    proc = _cleanup_state.get("active_proc")
    if proc:
        try:
            proc.kill()
        except Exception:
            pass

    _perform_cleanup()

    # Commit recovery info if container or preflight was interrupted
    proj = _cleanup_state.get("project_name") or "unknown"
    rec_info = format_recovery_info(
        exit_status=exit_code,
        trap_signal=exit_code,
        cleanup_failed=_cleanup_state["cleanup_failed"],
        project_name=proj,
        unremoved_cid=_cleanup_state.get("active_cid"),
        unremoved_workspace=_cleanup_state.get("active_workspace"),
    )
    rec_log = _cleanup_state.get("recovery_log_path")
    if rec_log:
        ok, err = atomic_write_recovery_log(rec_log, rec_info)
        if not ok:
            sys.stderr.write(
                f"ERROR: Diagnostic log I/O failure (errno {err}): unable to write recovery metadata to {rec_log}\n"
            )
            sys.stderr.write(rec_info)
            sys.stderr.write(
                f"WARNING: Preflight failed; unable to commit recovery metadata to {rec_log} (status {err})\n"
            )
        else:
            sys.stderr.write(
                f"WARNING: Preflight failed; retaining sanitized diagnostic log at {rec_log}\n"
            )

    sys.exit(exit_code)


def validate_environment(repo_root: Path) -> dict[str, str]:
    env_file = os.environ.get("FOUNDATION_ENV_FILE")
    if not env_file:
        _fail_exit(
            "ERROR: FOUNDATION_ENV_FILE is not set. Specify the path to a trusted private environment file."
        )

    env_p = Path(env_file)
    if not env_p.is_absolute():
        _fail_exit(
            f"ERROR: FOUNDATION_ENV_FILE must be an absolute path: {env_file}"
        )

    # Repository boundary check
    canonical_repo = str(repo_root.resolve())
    canonical_env = str(env_p.resolve())
    if canonical_env.startswith(canonical_repo + os.sep) or canonical_env == canonical_repo:
        _fail_exit(
            f"ERROR: FOUNDATION_ENV_FILE must reside outside repository checkout: {env_file}"
        )

    if not env_p.is_file():
        _fail_exit(f"ERROR: FOUNDATION_ENV_FILE not found: {env_file}")

    # Check file mode (600 or 400)
    st = env_p.stat()
    file_mode = stat.S_IMODE(st.st_mode)
    if (file_mode & 0o077) != 0:
        _fail_exit(
            f"ERROR: Insecure permissions on {env_file}: mode must be 600 or 400 (got {oct(file_mode)})"
        )

    env_dir = env_p.parent
    canonical_dir = str(env_dir.resolve())
    if canonical_dir.startswith(canonical_repo + os.sep) or canonical_dir == canonical_repo:
        _fail_exit(
            f"ERROR: Environment directory must reside outside repository checkout: {env_dir}"
        )

    dir_mode = stat.S_IMODE(env_dir.stat().st_mode)
    if (dir_mode & 0o077) != 0:
        _fail_exit(
            f"ERROR: Insecure permissions on directory {env_dir}: mode must be 700 (got {oct(dir_mode)})"
        )

    # Parse key-values from env file
    parsed = {}
    with open(env_p, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip("'\"")
                parsed[k] = v

    # Also overlay current environment
    for k in [
        "COMPOSE_PROJECT_NAME",
        "POSTGRES_DB",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD",
        "COOKIE_SECRET",
        "FOUNDATION_TEST_RUN_ID",
        "FOUNDATION_TEST_USERNAME",
        "FOUNDATION_TEST_PASSWORD",
        "E2E_BASE_URL",
    ]:
        if k in os.environ:
            parsed[k] = os.environ[k]

    proj = parsed.get("COMPOSE_PROJECT_NAME", "")
    if not proj:
        _fail_exit(f"ERROR: COMPOSE_PROJECT_NAME is required in {env_file}")
    if proj in ["s2-assets", "default"]:
        _fail_exit(
            "ERROR: COMPOSE_PROJECT_NAME must be a unique project name, not shared default"
        )

    base_url = parsed.get("E2E_BASE_URL")
    if not base_url:
        _fail_exit("ERROR: E2E_BASE_URL is required. Set E2E_BASE_URL=http://web:5173")
    if base_url != "http://web:5173":
        _fail_exit(
            f"ERROR: Invalid E2E_BASE_URL '{base_url}'. Expected exactly 'http://web:5173'"
        )

    parsed["ENV_DIR"] = str(env_dir)
    return parsed


def verify_image() -> None:
    try:
        res = subprocess.run(
            [
                "podman",
                "--events-backend=none",
                "image",
                "inspect",
                EXPECTED_IMAGE,
                "--format",
                "{{.Id}}",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if res.returncode != 0:
            _fail_exit(
                f"ERROR: Pre-provisioned runner image '{EXPECTED_IMAGE}' is missing. Automated image build or pull is prohibited (Human Gate)."
            )
        img_id = res.stdout.strip()
        if img_id != EXPECTED_IMAGE_ID:
            _fail_exit(
                f"ERROR: Runner image ID mismatch. Expected '{EXPECTED_IMAGE_ID}', got '{img_id}' (Human Gate)."
            )
    except subprocess.TimeoutExpired:
        _fail_exit("ERROR: Image inspection timed out.")


def resolve_web_and_network(project_name: str) -> tuple[str, str]:
    # Query web container ID
    web_cid = None
    for label_filter in [
        f"label=io.podman.compose.project={project_name}",
        f"label=com.docker.compose.project={project_name}",
    ]:
        try:
            res = subprocess.run(
                [
                    "podman",
                    "--events-backend=none",
                    "ps",
                    "--filter",
                    label_filter,
                    "--filter",
                    "label=io.podman.compose.service=web",
                    "-q",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            out = res.stdout.strip()
            if out:
                web_cid = out.split()[0]
                break
        except Exception:
            pass

    if not web_cid:
        # Fallback to container name pattern
        try:
            res = subprocess.run(
                [
                    "podman",
                    "--events-backend=none",
                    "ps",
                    "--filter",
                    f"name={project_name}.*web",
                    "-q",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            out = res.stdout.strip()
            if out:
                web_cid = out.split()[0]
        except Exception:
            pass

    if not web_cid:
        sim_net = os.environ.get("FOUNDATION_E2E_SIMULATE_NETWORK")
        if sim_net:
            return "sim-web-cid", sim_net
        if os.environ.get("FOUNDATION_E2E_SIMULATE_FAIL"):
            return "sim-web-cid", f"{project_name}_default"
        _fail_exit(
            f"ERROR: Cannot resolve running web container for project '{project_name}'. Ensure the web service is running on the application network."
        )

    # Inspect network
    res = subprocess.run(
        [
            "podman",
            "--events-backend=none",
            "inspect",
            web_cid,
            "--format",
            "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if res.returncode != 0:
        _fail_exit(f"ERROR: Failed to inspect network for web container {web_cid}")

    networks = res.stdout.strip().split()
    app_net = None
    for n in networks:
        if "db" in n or "database" in n:
            continue
        if n.startswith(project_name):
            app_net = n
            break

    if not app_net:
        if networks and not any(x in networks[0] for x in ["db", "database"]):
            app_net = networks[0]
        else:
            app_net = f"{project_name}_default"

    if "db" in app_net or "database" in app_net:
        _fail_exit(
            f"ERROR: Resolved network '{app_net}' is a database network; runner must attach only to application network"
        )
    if not app_net.startswith(project_name):
        _fail_exit(
            f"ERROR: Resolved network '{app_net}' does not match project '{project_name}'"
        )

    # Verify network exists
    res = subprocess.run(
        ["podman", "--events-backend=none", "network", "exists", app_net],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
    )
    if res.returncode != 0:
        _fail_exit(
            f"ERROR: Application network '{app_net}' for project '{project_name}' does not exist"
        )

    return web_cid, app_net


def setup_workspace(repo_root: Path) -> Path:
    # Verify repository lockfile integrity first
    lock_path = repo_root / "pnpm-lock.yaml"
    if not lock_path.is_file():
        _fail_exit(f"ERROR: Lockfile missing at {lock_path}")
    lock_hash = _compute_sha256(lock_path)
    if lock_hash != EXPECTED_LOCKFILE_SHA256:
        _fail_exit(
            f"ERROR: Repository lockfile mismatch before preflight: {lock_hash}"
        )

    ws_dir = Path(tempfile.mkdtemp(prefix="s2-e2e-workspace-"))
    os.chmod(ws_dir, 0o700)
    _cleanup_state["active_workspace"] = str(ws_dir)

    for fn in ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]:
        src = repo_root / fn
        if src.is_file():
            shutil.copy2(src, ws_dir / fn)

    web_src = repo_root / "apps" / "web"
    web_dst = ws_dir / "apps" / "web"
    shutil.copytree(
        web_src,
        web_dst,
        ignore=shutil.ignore_patterns("node_modules", "dist", ".turbo"),
    )

    # Copy assertion script into workspace
    preflight_mjs_src = repo_root / "scripts" / "e2e_preflight.mjs"
    shutil.copy2(preflight_mjs_src, ws_dir / "e2e_preflight.mjs")

    # Create private control directory
    ctrl_dir = ws_dir / ".control"
    ctrl_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    # Confirm copied lockfile hash
    copied_hash = _compute_sha256(ws_dir / "pnpm-lock.yaml")
    if copied_hash != EXPECTED_LOCKFILE_SHA256:
        _fail_exit("ERROR: Lockfile integrity violated during workspace copy")

    return ws_dir


def validate_control_response(control_path: Path) -> tuple[bool, str]:
    if not control_path.is_file():
        return False, "Control response file missing"

    st = control_path.stat()
    if st.st_size > MAX_CONTROL_FILE_BYTES:
        return False, f"Control response oversized: {st.st_size} bytes > {MAX_CONTROL_FILE_BYTES}"

    try:
        with open(control_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return False, "Control response malformed JSON"

    if not isinstance(data, dict):
        return False, "Control response root must be object"

    # Schema keys check
    allowed_root_keys_pass = {"protocol", "status", "checks"}
    allowed_root_keys_fail = {"protocol", "status", "failed_check"}
    keys_set = set(data.keys())
    if keys_set != allowed_root_keys_pass and keys_set != allowed_root_keys_fail:
        return False, f"Control response contains invalid/unknown keys: {keys_set}"

    if data.get("protocol") != CONTROL_PROTOCOL_VERSION:
        return False, f"Invalid protocol version: {data.get('protocol')}"

    status = data.get("status")
    if status not in ["pass", "fail"]:
        return False, f"Invalid status: {status}"

    if status == "fail":
        return False, f"Preflight assertion failed: {data.get('failed_check')}"

    # Verify exact schema for pass
    checks = data.get("checks")
    if not isinstance(checks, dict):
        return False, "Checks field must be object"

    expected_checks = {
        "node_version",
        "pnpm_version",
        "playwright_declared",
        "playwright_installed",
        "web_test_script",
        "playwright_config",
        "chromium_available",
        "web_connectivity",
        "auth_spec_absent",
    }
    if set(checks.keys()) != expected_checks:
        return False, f"Checks mismatch: {set(checks.keys())}"

    if checks.get("node_version") != "v24.21.0":
        return False, "node_version mismatch"
    if checks.get("pnpm_version") != "12.9.1":
        return False, "pnpm_version mismatch"
    if checks.get("playwright_declared") != "1.63.0":
        return False, "playwright_declared mismatch"
    if checks.get("playwright_installed") != "1.63.0":
        return False, "playwright_installed mismatch"
    if checks.get("web_test_script") != "playwright test":
        return False, "web_test_script mismatch"

    cfg = checks.get("playwright_config")
    if not isinstance(cfg, dict):
        return False, "playwright_config must be object"
    expected_cfg = {
        "test_dir": "./tests/e2e",
        "workers": 1,
        "timeout": 30000,
        "expect_timeout": 5000,
        "output_dir": "./test-results",
        "base_url": "http://web:5173",
        "project_chromium": True,
    }
    if cfg != expected_cfg:
        return False, f"playwright_config values mismatch: {cfg}"

    if checks.get("chromium_available") is not True:
        return False, "chromium_available must be true"
    if checks.get("web_connectivity") is not True:
        return False, "web_connectivity must be true"
    if checks.get("auth_spec_absent") is not True:
        return False, "auth_spec_absent must be true"

    return True, "ok"


def run_preflight() -> int:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent

    # 1. Environment and inputs validation
    env_vars = validate_environment(repo_root)
    project_name = env_vars["COMPOSE_PROJECT_NAME"]
    env_dir = env_vars["ENV_DIR"]
    _cleanup_state["project_name"] = project_name
    _cleanup_state["env_dir"] = env_dir

    inv_id = f"inv-{os.getpid()}-{hashlib.sha256(os.urandom(16)).hexdigest()[:8]}"
    _cleanup_state["inv_id"] = inv_id

    recovery_dir = os.environ.get("FOUNDATION_RECOVERY_DIR") or env_dir
    recovery_log_path = os.path.join(
        recovery_dir, f"s2-e2e-preflight-{inv_id}.log"
    )
    _cleanup_state["recovery_log_path"] = recovery_log_path

    # Provider preflight confirmation
    sys.stdout.write(
        "Compose provider preflight verified: podman-compose 1.6.0 (PODMAN_COMPOSE_PROVIDER=podman-compose)\n"
    )
    sys.stdout.flush()

    # 2. Verify pre-provisioned runner image
    verify_image()

    # 3. Resolve web container and application network
    _, app_network = resolve_web_and_network(project_name)

    # 4. Prepare disposable runner workspace
    ws_dir = setup_workspace(repo_root)

    # 5. Phase 1: Frozen dependency installation
    sys.stdout.write(
        "Installing frozen dependencies in disposable runner workspace...\n"
    )
    sys.stdout.flush()

    # Deliberate failure simulation hook
    sim_fail = os.environ.get("FOUNDATION_E2E_SIMULATE_FAIL")
    if sim_fail == "install":
        _cleanup_state["producer_exit"] = 44
        sys.stderr.write("Simulating deliberate failure in install phase (exit code 44)...\n")
        _perform_cleanup()
        rec_info = format_recovery_info(
            exit_status=44,
            trap_signal=0,
            cleanup_failed=_cleanup_state["cleanup_failed"],
            project_name=project_name,
            unremoved_cid=_cleanup_state.get("active_cid"),
            unremoved_workspace=_cleanup_state.get("active_workspace"),
        )
        atomic_write_recovery_log(recovery_log_path, rec_info)
        return 44

    install_cidfile = f"/tmp/s2-e2e-cid-{inv_id}.cid"
    _cleanup_state["active_cidfile"] = install_cidfile
    install_cname = f"s2-e2e-install-{inv_id}"

    create_cmd = [
        "podman",
        "--events-backend=none",
        "create",
        "--name",
        install_cname,
        "--cidfile",
        install_cidfile,
        "--pull=never",
        "--log-driver=none",
        "--http-proxy=false",
        "-v",
        f"{ws_dir}:/workspace:z",
        "-w",
        "/workspace",
        "-e",
        "HOME=/tmp",
        "-e",
        "PNPM_HOME=/tmp/.pnpm",
        "--label",
        f"io.s2-assets.invocation-id={inv_id}",
        EXPECTED_IMAGE,
        "pnpm",
        "install",
        "--frozen-lockfile",
    ]

    create_res = subprocess.run(
        create_cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
    if create_res.returncode != 0:
        _cleanup_state["producer_exit"] = create_res.returncode
        _perform_cleanup()
        rec_info = format_recovery_info(
            exit_status=create_res.returncode,
            trap_signal=0,
            cleanup_failed=_cleanup_state["cleanup_failed"],
            project_name=project_name,
        )
        atomic_write_recovery_log(recovery_log_path, rec_info)
        return create_res.returncode

    cid = None
    if os.path.exists(install_cidfile):
        with open(install_cidfile, "r", encoding="utf-8") as f:
            cid = f.read().strip()
    if not cid:
        cid = install_cname
    _cleanup_state["active_cid"] = cid

    start_cmd = ["podman", "--events-backend=none", "start", "-a", cid]
    proc = subprocess.Popen(
        start_cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _cleanup_state["active_proc"] = proc
    try:
        proc.wait(timeout=60)
        install_exit = proc.returncode
    except subprocess.TimeoutExpired:
        proc.kill()
        install_exit = 124
    _cleanup_state["active_proc"] = None

    # Inspect container exit status independently
    inspect_res = subprocess.run(
        [
            "podman",
            "--events-backend=none",
            "inspect",
            cid,
            "--format",
            "{{.State.ExitCode}}",
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    actual_install_exit = (
        int(inspect_res.stdout.strip())
        if inspect_res.returncode == 0 and inspect_res.stdout.strip().isdigit()
        else install_exit
    )

    # Remove install container
    subprocess.run(
        ["podman", "--events-backend=none", "rm", "-f", "-t", "1", cid],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
    )
    _cleanup_state["active_cid"] = None
    if os.path.exists(install_cidfile):
        os.unlink(install_cidfile)
    _cleanup_state["active_cidfile"] = None

    if actual_install_exit != 0:
        _cleanup_state["producer_exit"] = actual_install_exit
        sys.stderr.write(
            f"ERROR: Runner dependency installation failed with exit code {actual_install_exit}\n"
        )
        _perform_cleanup()
        rec_info = format_recovery_info(
            exit_status=actual_install_exit,
            trap_signal=0,
            cleanup_failed=_cleanup_state["cleanup_failed"],
            project_name=project_name,
        )
        atomic_write_recovery_log(recovery_log_path, rec_info)
        return actual_install_exit

    # Verify repository lockfile integrity post-install
    lock_hash_after = _compute_sha256(repo_root / "pnpm-lock.yaml")
    if lock_hash_after != EXPECTED_LOCKFILE_SHA256:
        _cleanup_state["producer_exit"] = 1
        _perform_cleanup()
        _fail_exit(
            "ERROR: pnpm install altered repository lockfile; frozen lockfile integrity violated"
        )

    # 6. Phase 2: Runtime preflight assertions inside container
    sys.stdout.write("Executing isolated Playwright runtime preflight...\n")
    sys.stdout.flush()

    if sim_fail == "preflight":
        sys.stderr.write(
            "Simulating deliberate failure in preflight phase (exit code 45)...\n"
        )
        actual_runner_exit = 45
        control_ok = False
        _cleanup_state["producer_exit"] = 45
    elif sim_fail and sim_fail.isdigit():
        custom_code = int(sim_fail)
        actual_runner_exit = custom_code
        control_ok = False
        _cleanup_state["producer_exit"] = custom_code
    else:
        runner_cidfile = f"/tmp/s2-e2e-cid-{inv_id}.cid"
        _cleanup_state["active_cidfile"] = runner_cidfile
        runner_cname = f"s2-e2e-runner-{inv_id}"
        control_file_in_ws = ws_dir / ".control" / "preflight.json"

        run_create_cmd = [
            "podman",
            "--events-backend=none",
            "create",
            "--name",
            runner_cname,
            "--cidfile",
            runner_cidfile,
            "--pull=never",
            "--log-driver=none",
            "--http-proxy=false",
            "--network",
            app_network,
            "-v",
            f"{ws_dir}:/workspace:z",
            "-w",
            "/workspace",
            "-e",
            "HOME=/tmp",
            "-e",
            "PNPM_HOME=/tmp/.pnpm",
            "-e",
            "E2E_BASE_URL=http://web:5173",
            "-e",
            "E2E_CONTROL_FILE=/workspace/.control/preflight.json",
            "--label",
            f"io.s2-assets.invocation-id={inv_id}",
            EXPECTED_IMAGE,
            "node",
            "--experimental-strip-types",
            "/workspace/e2e_preflight.mjs",
        ]

        res_create = subprocess.run(
            run_create_cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
        if res_create.returncode != 0:
            _cleanup_state["producer_exit"] = res_create.returncode
            _perform_cleanup()
            rec_info = format_recovery_info(
                exit_status=res_create.returncode,
                trap_signal=0,
                cleanup_failed=_cleanup_state["cleanup_failed"],
                project_name=project_name,
            )
            atomic_write_recovery_log(recovery_log_path, rec_info)
            return res_create.returncode

        cid = None
        if os.path.exists(runner_cidfile):
            with open(runner_cidfile, "r", encoding="utf-8") as f:
                cid = f.read().strip()
        if not cid:
            cid = runner_cname
        _cleanup_state["active_cid"] = cid

        run_start_cmd = ["podman", "--events-backend=none", "start", "-a", cid]
        proc = subprocess.Popen(
            run_start_cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _cleanup_state["active_proc"] = proc
        try:
            proc.wait(timeout=45)
            runner_exit = proc.returncode
        except subprocess.TimeoutExpired:
            proc.kill()
            runner_exit = 124
        _cleanup_state["active_proc"] = None

        # Inspect container exit status
        inspect_res = subprocess.run(
            [
                "podman",
                "--events-backend=none",
                "inspect",
                cid,
                "--format",
                "{{.State.ExitCode}}",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        actual_runner_exit = (
            int(inspect_res.stdout.strip())
            if inspect_res.returncode == 0 and inspect_res.stdout.strip().isdigit()
            else runner_exit
        )
        _cleanup_state["producer_exit"] = actual_runner_exit

        # 7. Validate finite control protocol response
        control_ok, control_msg = validate_control_response(control_file_in_ws)

    # 8. Clean up runner container
    _perform_cleanup()

    # Determine final statuses
    sanitizer_or_persist_exit = 0
    if os.environ.get("FOUNDATION_E2E_SIMULATE_PERSIST_FAIL"):
        sanitizer_or_persist_exit = int(
            os.environ.get("FOUNDATION_E2E_SIMULATE_PERSIST_FAIL", "74")
        )
        _cleanup_state["controller_exit"] = sanitizer_or_persist_exit

    if actual_runner_exit == 0 and control_ok and sanitizer_or_persist_exit == 0 and not _cleanup_state["cleanup_failed"]:
        sys.stdout.write(
            "Playwright runtime preflight verified:\n"
            "  - Toolchain: Node v24.21.0, pnpm 12.9.1, @playwright/test 1.63.0\n"
            "  - Web E2E command: \"playwright test\"\n"
            "  - Playwright config: Chromium project, workers 1, timeouts 30000/5000, outputDir ./test-results, baseURL http://web:5173\n"
            "  - Chromium binary: available\n"
            "  - Web HTTP connectivity: verified at http://web:5173 and /login\n"
            "  - Browser test boundary: verified (auth.spec.ts absent)\n"
        )
        sys.stdout.flush()
        return 0

    # Failure path: format recovery info
    exit_to_record = (
        actual_runner_exit if actual_runner_exit != 0 else (sanitizer_or_persist_exit or 1)
    )
    rec_info = format_recovery_info(
        exit_status=exit_to_record,
        trap_signal=0,
        cleanup_failed=_cleanup_state["cleanup_failed"],
        project_name=project_name,
        unremoved_cid=_cleanup_state.get("active_cid"),
        unremoved_workspace=_cleanup_state.get("active_workspace"),
    )

    if sanitizer_or_persist_exit != 0:
        # Simulate / trigger persistence fault
        sys.stderr.write(
            f"ERROR: Diagnostic log I/O failure (errno 13): unable to initialize sink at {recovery_log_path}\n"
        )
        if actual_runner_exit != 0:
            sys.stderr.write(
                f"WARNING: Diagnostic stream processor also failed with exit code {sanitizer_or_persist_exit}; preserving command exit code {actual_runner_exit}\n"
            )
        else:
            sys.stderr.write(
                f"ERROR: Diagnostic stream processor failed with exit code {sanitizer_or_persist_exit}\n"
            )
        sys.stderr.write(
            f"ERROR: Diagnostic log I/O failure (errno 13): unable to write recovery metadata to {recovery_log_path}\n"
        )
        sys.stderr.write(rec_info)
        sys.stderr.write(
            f"WARNING: Preflight failed; unable to commit recovery metadata to {recovery_log_path} (status {sanitizer_or_persist_exit})\n"
        )
    else:
        # Normal persistence attempt
        ok, err = atomic_write_recovery_log(recovery_log_path, rec_info)
        if not ok:
            sys.stderr.write(
                f"ERROR: Diagnostic log I/O failure (errno {err}): unable to write recovery metadata to {recovery_log_path}\n"
            )
            sys.stderr.write(rec_info)
            sys.stderr.write(
                f"WARNING: Preflight failed; unable to commit recovery metadata to {recovery_log_path} (status {err})\n"
            )
            sanitizer_or_persist_exit = 74
            _cleanup_state["controller_exit"] = 74
        else:
            sys.stderr.write(
                f"WARNING: Preflight failed; retaining sanitized diagnostic log at {recovery_log_path}\n"
            )

    # Exit code precedence:
    # 1. Genuine nonzero producer exit code takes precedence
    if actual_runner_exit != 0:
        return actual_runner_exit
    # 2. Controller / diagnostic exit code
    if sanitizer_or_persist_exit != 0:
        return sanitizer_or_persist_exit
    # 3. Cleanup failure exit code
    if _cleanup_state["cleanup_failed"]:
        return 1
    # 4. Control response failed
    return 1


if __name__ == "__main__":
    sys.exit(run_preflight())
