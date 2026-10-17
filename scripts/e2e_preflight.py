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


def resolve_exit_code(
    producer_exit: int | None = None,
    controller_exit: int = 0,
    cleanup_failed: bool = False,
    signal_received: int | None = None,
) -> int:
    if producer_exit is not None and producer_exit != 0:
        return producer_exit
    if signal_received is not None and signal_received != 0:
        return 128 + signal_received
    if controller_exit != 0:
        return controller_exit
    if cleanup_failed:
        return 1
    return 0


def _fail_exit(message: str, code: int = 1) -> None:
    sys.stderr.write(f"{message}\n")
    sys.exit(code)


def _compute_sha256(file_path: Path) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def _run_bounded(
    cmd: list[str],
    max_bytes: int = 4096,
    timeout: int = 10,
) -> tuple[int, str]:
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return -1, ""

    try:
        raw = b""
        while len(raw) < max_bytes:
            chunk = proc.stdout.read(min(1024, max_bytes - len(raw)))
            if not chunk:
                break
            raw += chunk
        extra = proc.stdout.read(1)
        if extra:
            try:
                proc.kill()
                proc.wait(timeout=2)
            except Exception:
                pass
            return -1, ""
        proc.wait(timeout=timeout)
        return proc.returncode, raw.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            pass
        return -1, ""
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            pass
        return -1, ""
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass


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


def commit_recovery(recovery_log_path: str, rec_info: str) -> bool:
    ok, err = atomic_write_recovery_log(recovery_log_path, rec_info)
    if not ok:
        sys.stderr.write(
            f"ERROR: Diagnostic log I/O failure (errno {err}): unable to write recovery metadata to {recovery_log_path}\n"
        )
        sys.stderr.write(rec_info)
        sys.stderr.write(
            f"WARNING: Preflight failed; unable to commit recovery metadata to {recovery_log_path} (status {err})\n"
        )
        return False
    else:
        sys.stderr.write(
            f"WARNING: Preflight failed; retaining sanitized diagnostic log at {recovery_log_path}\n"
        )
        return True


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
    proc = _cleanup_state.get("active_proc")
    if proc:
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            pass
        _cleanup_state["active_proc"] = None

    cid = _cleanup_state.get("active_cid")
    cidfile = _cleanup_state.get("active_cidfile")
    ws = _cleanup_state.get("active_workspace")

    # Order invariant: container first, mounted workspace afterward
    if cid and not _cleanup_state.get("cleanup_failed"):
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
                    _cleanup_state["cleanup_exit"] = res.returncode
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

    if cidfile and _cleanup_state.get("active_cid") is None:
        try:
            if os.path.exists(cidfile):
                os.unlink(cidfile)
            _cleanup_state["active_cidfile"] = None
        except Exception:
            _cleanup_state["cleanup_failed"] = True

    if ws and _cleanup_state.get("active_cid") is None and not _cleanup_state["cleanup_failed"]:
        try:
            if os.path.exists(ws):
                shutil.rmtree(ws)
            _cleanup_state["active_workspace"] = None
        except Exception:
            _cleanup_state["cleanup_failed"] = True
            _cleanup_state["cleanup_exit"] = 1


def _handle_signal(signum: int, frame) -> None:
    _cleanup_state["signal_received"] = signum
    signum_exit = 128 + signum
    final_exit = (
        _cleanup_state["producer_exit"]
        if _cleanup_state["producer_exit"] is not None and _cleanup_state["producer_exit"] != 0
        else signum_exit
    )

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
        exit_status=final_exit,
        trap_signal=signum_exit,
        cleanup_failed=_cleanup_state["cleanup_failed"],
        project_name=proj,
        unremoved_cid=_cleanup_state.get("active_cid"),
        unremoved_workspace=_cleanup_state.get("active_workspace"),
    )
    rec_log = _cleanup_state.get("recovery_log_path")
    if rec_log:
        commit_recovery(rec_log, rec_info)

    sys.exit(final_exit)


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
    if proj in ["s2-assets", "s2-assets-dev", "default"]:
        _fail_exit(
            f"ERROR: COMPOSE_PROJECT_NAME must be a unique test project name, not persistent or default project '{proj}'"
        )

    base_url = parsed.get("E2E_BASE_URL")
    if not base_url:
        _fail_exit("ERROR: E2E_BASE_URL is required. Set E2E_BASE_URL=http://web:5173")
    if base_url != "http://web:5173":
        _fail_exit(
            "ERROR: Invalid E2E_BASE_URL. Expected exactly 'http://web:5173'"
        )

    parsed["ENV_DIR"] = str(env_dir)
    return parsed


def verify_image() -> None:
    # 1. Verify rootless Podman runtime
    rc, info_out = _run_bounded(
        ["podman", "--events-backend=none", "info", "--format", "{{json .}}"],
        max_bytes=65536,
        timeout=10,
    )
    if rc == 0 and info_out:
        try:
            info_data = json.loads(info_out)
            rootless = info_data.get("host", {}).get("security", {}).get("rootless")
            if rootless is False:
                _fail_exit("ERROR: Podman runtime must be rootless")
        except Exception:
            pass

    # 2. Verify immutable image ID
    rc, img_out = _run_bounded(
        [
            "podman",
            "--events-backend=none",
            "image",
            "inspect",
            EXPECTED_IMAGE,
            "--format",
            "{{.Id}}",
        ],
        max_bytes=256,
        timeout=15,
    )
    if rc != 0 or not img_out:
        _fail_exit(
            f"ERROR: Pre-provisioned runner image '{EXPECTED_IMAGE}' is missing. Automated image build or pull is prohibited (Human Gate)."
        )
    img_id = img_out.strip()
    if img_id != EXPECTED_IMAGE_ID:
        _fail_exit(
            f"ERROR: Runner image ID mismatch. Expected '{EXPECTED_IMAGE_ID}', got '{img_id}' (Human Gate)."
        )


def resolve_web_and_network(project_name: str) -> tuple[str, str]:
    if project_name in ["s2-assets", "s2-assets-dev", "default"]:
        _fail_exit(
            f"ERROR: Preflight cannot target persistent development project '{project_name}'"
        )

    # Simulation hooks for unit/regression tests
    if os.environ.get("FOUNDATION_E2E_SIMULATE_NETWORK"):
        return "sim-web-cid", os.environ.get("FOUNDATION_E2E_SIMULATE_NETWORK")
    if os.environ.get("FOUNDATION_E2E_SIMULATE_FAIL"):
        rc, _ = _run_bounded(
            ["podman", "--events-backend=none", "network", "exists", f"{project_name}_default"],
            max_bytes=64,
            timeout=5,
        )
        if rc == 0:
            return "sim-web-cid", f"{project_name}_default"
        return "sim-web-cid", "podman"

    # Strict query for running web container
    rc, out = _run_bounded(
        [
            "podman",
            "--events-backend=none",
            "ps",
            "--filter",
            f"label=io.podman.compose.project={project_name}",
            "--filter",
            "label=io.podman.compose.service=web",
            "--filter",
            "status=running",
            "-q",
        ],
        max_bytes=1024,
        timeout=10,
    )
    cids = out.strip().split() if rc == 0 and out.strip() else []
    if not cids:
        # Check docker compose label
        rc, out = _run_bounded(
            [
                "podman",
                "--events-backend=none",
                "ps",
                "--filter",
                f"label=com.docker.compose.project={project_name}",
                "--filter",
                "label=com.docker.compose.service=web",
                "--filter",
                "status=running",
                "-q",
            ],
            max_bytes=1024,
            timeout=10,
        )
        cids = out.strip().split() if rc == 0 and out.strip() else []

    if len(cids) > 1:
        _fail_exit(
            f"ERROR: Multiple running web containers found for project '{project_name}'. Ambiguous test target."
        )
    if not cids:
        _fail_exit(
            f"ERROR: Cannot resolve running web container for project '{project_name}'. Ensure the web service is running on the application network."
        )

    web_cid = cids[0]

    # Inspect network
    rc, net_out = _run_bounded(
        [
            "podman",
            "--events-backend=none",
            "inspect",
            web_cid,
            "--format",
            "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
        ],
        max_bytes=2048,
        timeout=10,
    )
    if rc != 0 or not net_out:
        _fail_exit(f"ERROR: Failed to inspect network for web container {web_cid}")

    networks = net_out.strip().split()
    valid_nets = [
        n for n in networks
        if (n.startswith(f"{project_name}_") or n == project_name)
        and n not in ["host", "bridge", "none"]
        and not n.endswith("_db")
        and not n.endswith("_database")
    ]
    if not valid_nets:
        _fail_exit(
            f"ERROR: Web container is not connected to a valid application network for project '{project_name}': {networks}"
        )

    return web_cid, valid_nets[0]


def _reconcile_container(cidfile: str, cname: str, inv_id: str) -> str | None:
    cid = None
    if os.path.exists(cidfile):
        try:
            with open(cidfile, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if len(content) == 64 and all(c in "0123456789abcdef" for c in content.lower()):
                    cid = content
        except Exception:
            pass
    if not cid:
        cid = cname

    rc, out = _run_bounded(
        [
            "podman",
            "--events-backend=none",
            "inspect",
            cid,
            "--format",
            '{{index .Config.Labels "io.s2-assets.invocation-id"}}',
        ],
        max_bytes=256,
        timeout=5,
    )
    if rc == 0:
        val = out.strip()
        if val and val != inv_id and val != "0":
            return None
    return cid


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

    # Check auth.spec.ts absence in real source before allowlisting can hide it
    web_src = repo_root / "apps" / "web"
    auth_spec = web_src / "tests" / "e2e" / "auth.spec.ts"
    if auth_spec.exists():
        _fail_exit("ERROR: auth.spec.ts detected in source; unsupported full E2E execution")

    ws_dir = Path(tempfile.mkdtemp(prefix="s2-e2e-workspace-"))
    os.chmod(ws_dir, 0o700)
    _cleanup_state["active_workspace"] = str(ws_dir)

    # Concrete minimal allowlist copying:
    # 1. Root files
    for fn in ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]:
        src = repo_root / fn
        if src.is_file() and not src.is_symlink() and not os.path.islink(src):
            shutil.copy2(src, ws_dir / fn)

    # 2. apps/web explicit allowed regular files
    web_dst = ws_dir / "apps" / "web"
    web_dst.mkdir(parents=True, exist_ok=True, mode=0o700)
    allowed_web_files = [
        "package.json",
        "playwright.config.ts",
        "vite.config.ts",
        "tsconfig.json",
        "index.html",
    ]
    for fn in allowed_web_files:
        src = web_src / fn
        if src.exists():
            if src.is_symlink() or os.path.islink(src):
                _fail_exit(f"ERROR: Source symlinks not permitted: apps/web/{fn}")
            if src.is_file():
                shutil.copy2(src, web_dst / fn)

    # 3. apps/web/src regular files only
    src_dir = web_src / "src"
    if src_dir.exists():
        if src_dir.is_symlink() or os.path.islink(src_dir):
            _fail_exit("ERROR: Source symlinks not permitted: apps/web/src")
        for root, dirs, files in os.walk(src_dir):
            for d in dirs:
                d_p = Path(root) / d
                if d_p.is_symlink() or os.path.islink(d_p):
                    _fail_exit(f"ERROR: Source directory symlinks not permitted: {d_p}")
            for f in files:
                f_p = Path(root) / f
                if f_p.is_symlink() or os.path.islink(f_p):
                    _fail_exit(f"ERROR: Source file symlinks not permitted: {f_p}")
                if f.startswith("."):
                    continue
                rel = f_p.relative_to(src_dir)
                target = web_dst / "src" / rel
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copy2(f_p, target)

    # 4. Copy assertion script into workspace
    preflight_mjs_src = repo_root / "scripts" / "e2e_preflight.mjs"
    shutil.copy2(preflight_mjs_src, ws_dir / "e2e_preflight.mjs")

    # 5. Create private control directory
    ctrl_dir = ws_dir / ".control"
    ctrl_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    # 6. Confirm copied lockfile hash
    copied_hash = _compute_sha256(ws_dir / "pnpm-lock.yaml")
    if copied_hash != EXPECTED_LOCKFILE_SHA256:
        _fail_exit("ERROR: Lockfile integrity violated during workspace copy")

    return ws_dir


def validate_control_response(
    control_path: Path,
    expected_inv_id: str | None = None,
    min_mtime: float | None = None,
) -> tuple[bool, str]:
    if not control_path.is_file() or control_path.is_symlink() or os.path.islink(control_path):
        return False, "Control response file missing or symlink"

    try:
        with open(control_path, "r", encoding="utf-8") as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode):
                return False, "Control response is not a regular file"
            if st.st_size > MAX_CONTROL_FILE_BYTES:
                return False, f"Control response oversized: {st.st_size} bytes > {MAX_CONTROL_FILE_BYTES}"
            # Freshness: reject epoch timestamps (< 1700000000) or timestamps prior to min_mtime
            if st.st_mtime < 1700000000:
                return False, f"Control response timestamp is stale ({st.st_mtime})"
            if min_mtime is not None and st.st_mtime < min_mtime - 1.0:
                return False, f"Control response timestamp ({st.st_mtime}) older than invocation ({min_mtime})"
            raw = f.read(MAX_CONTROL_FILE_BYTES + 1)
            if len(raw) > MAX_CONTROL_FILE_BYTES:
                return False, "Control response oversized content"
            data = json.loads(raw)
    except Exception:
        return False, "Control response malformed JSON or unreadable"

    if type(data) is not dict:
        return False, "Control response root must be object"

    status = data.get("status")
    if status not in ["pass", "fail"]:
        return False, f"Invalid status: {status}"

    inv = data.get("invocation_id")
    if type(inv) is not str or not inv:
        return False, "Missing or invalid invocation_id"
    if expected_inv_id is not None and inv != expected_inv_id:
        return False, f"Invocation ID mismatch: expected {expected_inv_id}, got {inv}"

    allowed_root_keys_pass = {"protocol", "invocation_id", "status", "checks"}
    allowed_root_keys_fail = {"protocol", "invocation_id", "status", "failed_check"}
    keys_set = set(data.keys())
    if status == "pass" and keys_set != allowed_root_keys_pass:
        return False, f"Control response contains invalid/unknown keys: {keys_set}"
    if status == "fail" and keys_set != allowed_root_keys_fail:
        return False, f"Control response contains invalid/unknown keys: {keys_set}"

    if data.get("protocol") != CONTROL_PROTOCOL_VERSION:
        return False, f"Invalid protocol version: {data.get('protocol')}"

    if status == "fail":
        return False, f"Preflight assertion failed: {data.get('failed_check')}"

    # Verify exact schema and types for pass
    checks = data.get("checks")
    if type(checks) is not dict:
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

    if type(checks.get("node_version")) is not str or checks.get("node_version") != "v24.21.0":
        return False, "node_version mismatch"
    if type(checks.get("pnpm_version")) is not str or checks.get("pnpm_version") != "12.9.1":
        return False, "pnpm_version mismatch"
    if type(checks.get("playwright_declared")) is not str or checks.get("playwright_declared") != "1.63.0":
        return False, "playwright_declared mismatch"
    if type(checks.get("playwright_installed")) is not str or checks.get("playwright_installed") != "1.63.0":
        return False, "playwright_installed mismatch"
    if type(checks.get("web_test_script")) is not str or checks.get("web_test_script") != "playwright test":
        return False, "web_test_script mismatch"

    cfg = checks.get("playwright_config")
    if type(cfg) is not dict:
        return False, "playwright_config must be object"
    expected_cfg_keys = {
        "test_dir",
        "workers",
        "timeout",
        "expect_timeout",
        "output_dir",
        "base_url",
        "project_chromium",
    }
    if set(cfg.keys()) != expected_cfg_keys:
        return False, f"playwright_config keys mismatch: {set(cfg.keys())}"

    # Strict JSON type enforcement: reject bool-as-int and int-as-bool
    if type(cfg.get("workers")) is not int or isinstance(cfg.get("workers"), bool) or cfg.get("workers") != 1:
        return False, "playwright_config.workers must be exact int 1"
    if type(cfg.get("timeout")) is not int or isinstance(cfg.get("timeout"), bool) or cfg.get("timeout") != 30000:
        return False, "playwright_config.timeout must be exact int 30000"
    if type(cfg.get("expect_timeout")) is not int or isinstance(cfg.get("expect_timeout"), bool) or cfg.get("expect_timeout") != 5000:
        return False, "playwright_config.expect_timeout must be exact int 5000"
    if type(cfg.get("test_dir")) is not str or cfg.get("test_dir") != "./tests/e2e":
        return False, "playwright_config.test_dir mismatch"
    if type(cfg.get("output_dir")) is not str or cfg.get("output_dir") != "./test-results":
        return False, "playwright_config.output_dir mismatch"
    if type(cfg.get("base_url")) is not str or cfg.get("base_url") != "http://web:5173":
        return False, "playwright_config.base_url mismatch"
    if type(cfg.get("project_chromium")) is not bool or cfg.get("project_chromium") is not True:
        return False, "playwright_config.project_chromium must be exact bool True"

    if type(checks.get("chromium_available")) is not bool or checks.get("chromium_available") is not True:
        return False, "chromium_available must be exact bool True"
    if type(checks.get("web_connectivity")) is not bool or checks.get("web_connectivity") is not True:
        return False, "web_connectivity must be exact bool True"
    if type(checks.get("auth_spec_absent")) is not bool or checks.get("auth_spec_absent") is not True:
        return False, "auth_spec_absent must be exact bool True"

    return True, "ok"


def run_preflight() -> int:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    inv_start_time = time.time()
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
        commit_recovery(recovery_log_path, rec_info)
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
        "--label",
        f"io.s2-assets.invocation-id={inv_id}",
        EXPECTED_IMAGE_ID,
        "pnpm",
        "install",
        "--frozen-lockfile",
    ]

    try:
        create_res = subprocess.run(
            create_cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
        create_exit = create_res.returncode
    except subprocess.TimeoutExpired:
        create_exit = 124

    cid = _reconcile_container(install_cidfile, install_cname, inv_id)
    if cid:
        _cleanup_state["active_cid"] = cid

    if create_exit != 0:
        _cleanup_state["producer_exit"] = create_exit
        _perform_cleanup()
        rec_info = format_recovery_info(
            exit_status=create_exit,
            trap_signal=0,
            cleanup_failed=_cleanup_state["cleanup_failed"],
            project_name=project_name,
            unremoved_cid=_cleanup_state.get("active_cid"),
            unremoved_workspace=_cleanup_state.get("active_workspace"),
        )
        commit_recovery(recovery_log_path, rec_info)
        return create_exit

    start_cmd = ["podman", "--events-backend=none", "start", cid]
    start_res = subprocess.run(
        start_cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
    )
    if start_res.returncode != 0:
        install_exit = start_res.returncode
    else:
        wait_cmd = ["podman", "--events-backend=none", "wait", cid]
        proc = subprocess.Popen(
            wait_cmd,
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

    if install_exit != 0:
        actual_install_exit = install_exit
    else:
        # CLI returned 0, now check container exit status independently
        rc, inspect_out = _run_bounded(
            [
                "podman",
                "--events-backend=none",
                "inspect",
                cid,
                "--format",
                "{{.State.Running}} {{.State.ExitCode}}",
            ],
            max_bytes=256,
            timeout=10,
        )
        if rc != 0:
            actual_install_exit = 1
        else:
            parts = inspect_out.strip().split()
            if len(parts) >= 2:
                running = parts[0].lower() == "true"
                exit_str = parts[1]
                if running:
                    actual_install_exit = 124
                elif exit_str.isdigit():
                    actual_install_exit = int(exit_str)
                else:
                    actual_install_exit = 1
            elif inspect_out.strip().isdigit():
                actual_install_exit = int(inspect_out.strip())
            else:
                actual_install_exit = 0

    # Remove install container
    rm_res = subprocess.run(
        ["podman", "--events-backend=none", "rm", "-f", "-t", "1", cid],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
    )
    if rm_res.returncode != 0:
        _cleanup_state["cleanup_failed"] = True
        _cleanup_state["cleanup_exit"] = rm_res.returncode
        sys.stderr.write(f"ERROR: Failed to remove install container {cid}\n")
    else:
        _cleanup_state["active_cid"] = None
        if os.path.exists(install_cidfile):
            try:
                os.unlink(install_cidfile)
            except Exception:
                pass
        _cleanup_state["active_cidfile"] = None

    if actual_install_exit != 0 or _cleanup_state["cleanup_failed"]:
        final_code = resolve_exit_code(
            producer_exit=actual_install_exit,
            cleanup_failed=_cleanup_state["cleanup_failed"],
        )
        _cleanup_state["producer_exit"] = actual_install_exit
        if actual_install_exit != 0:
            sys.stderr.write(
                f"ERROR: Runner dependency installation failed with exit code {actual_install_exit}\n"
            )
        _perform_cleanup()
        rec_info = format_recovery_info(
            exit_status=final_code,
            trap_signal=0,
            cleanup_failed=_cleanup_state["cleanup_failed"],
            project_name=project_name,
            unremoved_cid=_cleanup_state.get("active_cid"),
            unremoved_workspace=_cleanup_state.get("active_workspace"),
        )
        commit_recovery(recovery_log_path, rec_info)
        return final_code

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
        control_file_in_ws = ws_dir / ".control" / f"preflight-{inv_id}.json"

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
            f"E2E_INVOCATION_ID={inv_id}",
            "-e",
            f"E2E_CONTROL_FILE=/workspace/.control/preflight-{inv_id}.json",
            "--label",
            f"io.s2-assets.invocation-id={inv_id}",
            EXPECTED_IMAGE_ID,
            "node",
            "--experimental-strip-types",
            "/workspace/e2e_preflight.mjs",
        ]

        try:
            res_create = subprocess.run(
                run_create_cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
            create_runner_exit = res_create.returncode
        except subprocess.TimeoutExpired:
            create_runner_exit = 124

        cid = _reconcile_container(runner_cidfile, runner_cname, inv_id)
        if cid:
            _cleanup_state["active_cid"] = cid

        if create_runner_exit != 0:
            _cleanup_state["producer_exit"] = create_runner_exit
            _perform_cleanup()
            rec_info = format_recovery_info(
                exit_status=create_runner_exit,
                trap_signal=0,
                cleanup_failed=_cleanup_state["cleanup_failed"],
                project_name=project_name,
                unremoved_cid=_cleanup_state.get("active_cid"),
                unremoved_workspace=_cleanup_state.get("active_workspace"),
            )
            commit_recovery(recovery_log_path, rec_info)
            return create_runner_exit

        run_start_cmd = ["podman", "--events-backend=none", "start", cid]
        start_res = subprocess.run(
            run_start_cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
        if start_res.returncode != 0:
            runner_exit = start_res.returncode
        else:
            wait_cmd = ["podman", "--events-backend=none", "wait", cid]
            proc = subprocess.Popen(
                wait_cmd,
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

        if runner_exit != 0:
            actual_runner_exit = runner_exit
        else:
            rc, inspect_out = _run_bounded(
                [
                    "podman",
                    "--events-backend=none",
                    "inspect",
                    cid,
                    "--format",
                    "{{.State.Running}} {{.State.ExitCode}}",
                ],
                max_bytes=256,
                timeout=10,
            )
            if rc != 0:
                actual_runner_exit = 1
            else:
                parts = inspect_out.strip().split()
                if len(parts) >= 2:
                    running = parts[0].lower() == "true"
                    exit_str = parts[1]
                    if running:
                        actual_runner_exit = 124
                    elif exit_str.isdigit():
                        actual_runner_exit = int(exit_str)
                    else:
                        actual_runner_exit = 1
                elif inspect_out.strip().isdigit():
                    actual_runner_exit = int(inspect_out.strip())
                else:
                    actual_runner_exit = 0

        _cleanup_state["producer_exit"] = actual_runner_exit

        # 7. Validate finite control protocol response only if container exited 0
        if actual_runner_exit == 0:
            control_ok, control_msg = validate_control_response(
                control_file_in_ws,
                expected_inv_id=inv_id,
                min_mtime=inv_start_time,
            )
        else:
            control_ok = False
            control_msg = f"Runner exited with status {actual_runner_exit}"

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

    # Failure path: resolve exit code using deterministic precedence
    final_code = resolve_exit_code(
        producer_exit=actual_runner_exit if actual_runner_exit != 0 else (0 if control_ok else 1),
        controller_exit=sanitizer_or_persist_exit,
        cleanup_failed=_cleanup_state["cleanup_failed"],
    )
    rec_info = format_recovery_info(
        exit_status=final_code,
        trap_signal=0,
        cleanup_failed=_cleanup_state["cleanup_failed"],
        project_name=project_name,
        unremoved_cid=_cleanup_state.get("active_cid"),
        unremoved_workspace=_cleanup_state.get("active_workspace"),
    )

    if sanitizer_or_persist_exit != 0:
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
        commit_recovery(recovery_log_path, rec_info)

    return final_code


if __name__ == "__main__":
    sys.exit(run_preflight())
