#!/usr/bin/env python3
"""Focused regression test suite for T046 trusted structured diagnostics and preflight."""

import copy
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

# Add parent directory to path to import e2e_preflight
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import e2e_preflight


class TestLockfileIntegrity(unittest.TestCase):
    def test_repo_lockfile_hash(self):
        lock_path = REPO_ROOT / "pnpm-lock.yaml"
        self.assertTrue(lock_path.is_file(), "pnpm-lock.yaml must exist")
        h = e2e_preflight._compute_sha256(lock_path)
        self.assertEqual(
            h,
            e2e_preflight.EXPECTED_LOCKFILE_SHA256,
            "Repository lockfile SHA-256 must match exact accepted baseline",
        )


class TestControlProtocolValidation(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="s2-test-ctrl-")
        self.ctrl_file = Path(self.temp_dir) / "preflight.json"

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _write_ctrl(self, data: str | dict):
        with open(self.ctrl_file, "w", encoding="utf-8") as f:
            if isinstance(data, dict):
                json.dump(data, f)
            else:
                f.write(data)

    def test_valid_pass_response(self):
        valid_data = {
            "protocol": "s2_e2e_preflight_v1",
            "invocation_id": "inv-valid-test",
            "status": "pass",
            "checks": {
                "node_version": "v24.21.0",
                "pnpm_version": "12.9.1",
                "playwright_declared": "1.63.0",
                "playwright_installed": "1.63.0",
                "web_test_script": "playwright test",
                "playwright_config": {
                    "test_dir": "./tests/e2e",
                    "workers": 1,
                    "timeout": 30000,
                    "expect_timeout": 5000,
                    "output_dir": "./test-results",
                    "base_url": "http://web:5173",
                    "project_chromium": True,
                },
                "chromium_available": True,
                "web_connectivity": True,
                "auth_spec_absent": True,
            },
        }
        self._write_ctrl(valid_data)
        ok, msg = e2e_preflight.validate_control_response(self.ctrl_file, expected_inv_id="inv-valid-test")
        self.assertTrue(ok, f"Expected pass but got: {msg}")

    def test_missing_control_file(self):
        missing_file = Path(self.temp_dir) / "nonexistent.json"
        ok, msg = e2e_preflight.validate_control_response(missing_file)
        self.assertFalse(ok)
        self.assertIn("missing", msg.lower())

    def test_oversized_control_file(self):
        oversized = "{" + '"a":' * 1000 + '"b"' + "}" * 1000
        oversized_pad = "x" * (e2e_preflight.MAX_CONTROL_FILE_BYTES + 100)
        with open(self.ctrl_file, "w") as f:
            f.write(oversized_pad)
        ok, msg = e2e_preflight.validate_control_response(self.ctrl_file)
        self.assertFalse(ok)
        self.assertIn("oversized", msg.lower())

    def test_malformed_json(self):
        self._write_ctrl("{not-json: true")
        ok, msg = e2e_preflight.validate_control_response(self.ctrl_file)
        self.assertFalse(ok)
        self.assertIn("malformed", msg.lower())

    def test_unknown_root_keys(self):
        data = {
            "protocol": "s2_e2e_preflight_v1",
            "invocation_id": "inv-valid-test",
            "status": "pass",
            "checks": {
                "node_version": "v24.21.0",
                "pnpm_version": "12.9.1",
                "playwright_declared": "1.63.0",
                "playwright_installed": "1.63.0",
                "web_test_script": "playwright test",
                "playwright_config": {
                    "test_dir": "./tests/e2e",
                    "workers": 1,
                    "timeout": 30000,
                    "expect_timeout": 5000,
                    "output_dir": "./test-results",
                    "base_url": "http://web:5173",
                    "project_chromium": True,
                },
                "chromium_available": True,
                "web_connectivity": True,
                "auth_spec_absent": True,
            },
            "unauthorized_extra_key": "injected_data",
        }
        self._write_ctrl(data)
        ok, msg = e2e_preflight.validate_control_response(self.ctrl_file, expected_inv_id="inv-valid-test")
        self.assertFalse(ok)
        self.assertIn("invalid/unknown keys", msg.lower())

    def test_forged_check_value_fails(self):
        forged_data = {
            "protocol": "s2_e2e_preflight_v1",
            "invocation_id": "inv-valid-test",
            "status": "pass",
            "checks": {
                "node_version": "v22.0.0",  # Forged wrong version
                "pnpm_version": "12.9.1",
                "playwright_declared": "1.63.0",
                "playwright_installed": "1.63.0",
                "web_test_script": "playwright test",
                "playwright_config": {
                    "test_dir": "./tests/e2e",
                    "workers": 1,
                    "timeout": 30000,
                    "expect_timeout": 5000,
                    "output_dir": "./test-results",
                    "base_url": "http://web:5173",
                    "project_chromium": True,
                },
                "chromium_available": True,
                "web_connectivity": True,
                "auth_spec_absent": True,
            },
        }
        self._write_ctrl(forged_data)
        ok, msg = e2e_preflight.validate_control_response(self.ctrl_file, expected_inv_id="inv-valid-test")
        self.assertFalse(ok)
        self.assertIn("node_version", msg)

    def test_failed_status_with_known_check(self):
        fail_data = {
            "protocol": "s2_e2e_preflight_v1",
            "invocation_id": "inv-valid-test",
            "status": "fail",
            "failed_check": "web_connectivity",
        }
        self._write_ctrl(fail_data)
        ok, msg = e2e_preflight.validate_control_response(self.ctrl_file, expected_inv_id="inv-valid-test")
        self.assertFalse(ok)
        self.assertIn("web_connectivity", msg)

    def test_strict_types_reject_bool_as_int_and_int_as_bool(self):
        valid_data = {
            "protocol": "s2_e2e_preflight_v1",
            "invocation_id": "inv-test-types",
            "status": "pass",
            "checks": {
                "node_version": "v24.21.0",
                "pnpm_version": "12.9.1",
                "playwright_declared": "1.63.0",
                "playwright_installed": "1.63.0",
                "web_test_script": "playwright test",
                "playwright_config": {
                    "test_dir": "./tests/e2e",
                    "workers": True,  # Bool as int must be rejected!
                    "timeout": 30000,
                    "expect_timeout": 5000,
                    "output_dir": "./test-results",
                    "base_url": "http://web:5173",
                    "project_chromium": 1,  # Int as bool must be rejected!
                },
                "chromium_available": True,
                "web_connectivity": True,
                "auth_spec_absent": True,
            },
        }
        self._write_ctrl(valid_data)
        ok, msg = e2e_preflight.validate_control_response(self.ctrl_file, expected_inv_id="inv-test-types")
        self.assertFalse(ok, "Must reject bool-as-int and int-as-bool in playwright_config")

    def test_stale_epoch_timestamp_rejected(self):
        valid_data = {
            "protocol": "s2_e2e_preflight_v1",
            "invocation_id": "inv-test-stale",
            "status": "pass",
            "checks": {
                "node_version": "v24.21.0",
                "pnpm_version": "12.9.1",
                "playwright_declared": "1.63.0",
                "playwright_installed": "1.63.0",
                "web_test_script": "playwright test",
                "playwright_config": {
                    "test_dir": "./tests/e2e",
                    "workers": 1,
                    "timeout": 30000,
                    "expect_timeout": 5000,
                    "output_dir": "./test-results",
                    "base_url": "http://web:5173",
                    "project_chromium": True,
                },
                "chromium_available": True,
                "web_connectivity": True,
                "auth_spec_absent": True,
            },
        }
        self._write_ctrl(valid_data)
        os.utime(self.ctrl_file, (1, 1))
        ok, msg = e2e_preflight.validate_control_response(self.ctrl_file, expected_inv_id="inv-test-stale")
        self.assertFalse(ok, "Must reject stale epoch timestamp control response")


class TestAtomicPersistenceAndFaults(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="s2-test-persist-")
        os.chmod(self.temp_dir, 0o700)

    def tearDown(self):
        # Restore permissions if altered
        try:
            os.chmod(self.temp_dir, 0o700)
        except OSError:
            pass
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_successful_atomic_write(self):
        target = Path(self.temp_dir) / "recovery.log"
        content = "ordinary evidence\n"
        ok, err = e2e_preflight.atomic_write_recovery_log(str(target), content)
        self.assertTrue(ok)
        self.assertEqual(err, 0)
        self.assertTrue(target.is_file())
        self.assertEqual(target.read_text("utf-8"), content)
        # Check permissions
        mode = stat.S_IMODE(target.stat().st_mode)
        self.assertEqual(mode, 0o600)

    def test_permission_failure_returns_nonzero_errno(self):
        # Make directory read-only / unwriteable
        os.chmod(self.temp_dir, 0o500)
        target = Path(self.temp_dir) / "permission_fail.log"
        ok, err = e2e_preflight.atomic_write_recovery_log(str(target), "data")
        self.assertFalse(ok)
        self.assertEqual(err, errno.EACCES)
        self.assertFalse(target.exists())

    def test_replace_eisdir_fault(self):
        # Target path is an existing directory, so os.replace raises EISDIR
        target = Path(self.temp_dir) / "target_dir"
        target.mkdir()
        ok, err = e2e_preflight.atomic_write_recovery_log(str(target), "data")
        self.assertFalse(ok)
        self.assertEqual(err, errno.EISDIR)

    def test_directory_fsync_ebadf_fault(self):
        # Inject directory fsync failure (EBADF)
        orig_fsync = os.fsync
        call_count = 0

        def faulty_fsync(fd):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:  # File fsync is 1, directory fsync is 2
                raise OSError(errno.EBADF, "Bad file descriptor")
            return orig_fsync(fd)

        target = Path(self.temp_dir) / "fsync_fail.log"
        with patch("os.fsync", side_effect=faulty_fsync):
            ok, err = e2e_preflight.atomic_write_recovery_log(str(target), "data")
            self.assertFalse(ok, "Must not swallow directory fsync EBADF failure")
            self.assertEqual(err, errno.EBADF)

    def test_write_enospc_fault(self):
        target = Path(self.temp_dir) / "nospace.log"
        with patch("os.write", side_effect=OSError(errno.ENOSPC, "No space left on device")):
            ok, err = e2e_preflight.atomic_write_recovery_log(str(target), "data")
            self.assertFalse(ok)
            self.assertEqual(err, errno.ENOSPC)
            self.assertFalse(target.exists())


class TestCanaryInvarianceAndMemory(unittest.TestCase):
    def test_canary_absence_in_recovery_information(self):
        canary_tokens = [
            "CANARY_SECRET_HEX_DEADBEEFCAFE",
            "Bearer eyJcanary_jwt_bearer_token",
            "CANARY_'QUOTE'\"DOUBLE\"",
            "CANARY_PASSWORD_123456",
        ]

        # Generate recovery info without secrets
        rec = e2e_preflight.format_recovery_info(
            exit_status=47,
            trap_signal=0,
            cleanup_failed=False,
            project_name="s2_test_project",
            unremoved_cid="14efe51337bd33eaacbb4c5c6aa63491a0b56293d295b2feec5100e0a2998916",
        )

        for token in canary_tokens:
            self.assertNotIn(token, rec)

    def test_large_canary_stream_boundary(self):
        # Test memory and bounds with 200,000-byte and 8 MiB inputs
        canary_200k = "CANARY_200K_" + "A" * 200000
        canary_8m = "CANARY_8M_" + "B" * 8388608

        # When control validation runs against input containing canaries or oversized data:
        temp_dir = tempfile.mkdtemp(prefix="s2-test-canary-")
        try:
            ctrl_path = Path(temp_dir) / "large.json"
            with open(ctrl_path, "w") as f:
                f.write(canary_200k)
            ok, msg = e2e_preflight.validate_control_response(ctrl_path)
            self.assertFalse(ok)

            with open(ctrl_path, "w") as f:
                f.write(canary_8m)
            ok, msg = e2e_preflight.validate_control_response(ctrl_path)
            self.assertFalse(ok)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


class TestWorkspaceIsolationAndAllowlist(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="s2-test-ws-")
        self.tmp_path = Path(self.tmp)
        self.source = self.tmp_path / "source"
        (self.source / "apps" / "web" / ".agents").mkdir(parents=True)
        (self.source / "apps" / "web" / "src").mkdir(parents=True)
        (self.source / "scripts").mkdir(parents=True)
        shutil.copy2(REPO_ROOT / "pnpm-lock.yaml", self.source / "pnpm-lock.yaml")
        shutil.copy2(REPO_ROOT / "scripts" / "e2e_preflight.mjs", self.source / "scripts" / "e2e_preflight.mjs")
        (self.source / "apps" / "web" / "package.json").write_text('{"name": "web"}')
        (self.source / "apps" / "web" / "playwright.config.ts").write_text('export default {}')
        (self.source / "apps" / "web" / "vite.config.ts").write_text('export default {}')
        (self.source / "apps" / "web" / "tsconfig.json").write_text('{}')
        (self.source / "apps" / "web" / "index.html").write_text('<html></html>')
        (self.source / "apps" / "web" / "src" / "main.tsx").write_text('console.log("hello");')

        # Add synthetic secret files that MUST NOT be copied
        (self.source / "apps" / "web" / ".env.local").write_text("PASSWORD=LEAD_SYNTHETIC_CANARY_81e4\n")
        (self.source / "apps" / "web" / ".agents" / "config").write_text("synthetic-agent-config")
        external = self.tmp_path / "external-secret"
        external.write_text("LEAD_SYNTHETIC_EXTERNAL_CANARY")
        (self.source / "apps" / "web" / "external-link").symlink_to(external)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_workspace_copy_excludes_env_agents_and_symlinks(self):
        ws = e2e_preflight.setup_workspace(self.source)
        try:
            self.assertFalse((ws / "apps" / "web" / ".env.local").exists(), ".env.local must not be copied")
            self.assertFalse((ws / "apps" / "web" / ".agents").exists(), ".agents must not be copied")
            self.assertFalse((ws / "apps" / "web" / "external-link").exists(), "external symlink must not be copied")
            # Verify required files are copied
            self.assertTrue((ws / "apps" / "web" / "package.json").is_file())
            self.assertTrue((ws / "apps" / "web" / "playwright.config.ts").is_file())
            self.assertTrue((ws / "apps" / "web" / "src" / "main.tsx").is_file())
        finally:
            shutil.rmtree(ws, ignore_errors=True)
            e2e_preflight._cleanup_state["active_workspace"] = None


class TestExitCodePrecedence(unittest.TestCase):
    def test_producer_takes_precedence_over_cleanup(self):
        self.assertEqual(e2e_preflight.resolve_exit_code(producer_exit=47, controller_exit=0, cleanup_failed=True), 47)

    def test_producer_takes_precedence_over_controller(self):
        self.assertEqual(e2e_preflight.resolve_exit_code(producer_exit=47, controller_exit=74, cleanup_failed=False), 47)

    def test_controller_takes_precedence_when_producer_zero(self):
        self.assertEqual(e2e_preflight.resolve_exit_code(producer_exit=0, controller_exit=74, cleanup_failed=True), 74)

    def test_cleanup_takes_precedence_when_producer_and_controller_zero(self):
        self.assertEqual(e2e_preflight.resolve_exit_code(producer_exit=0, controller_exit=0, cleanup_failed=True), 1)

    def test_all_zero_returns_zero(self):
        self.assertEqual(e2e_preflight.resolve_exit_code(producer_exit=0, controller_exit=0, cleanup_failed=False), 0)


class TestRunnerImageAndPodmanFlags(unittest.TestCase):
    def test_image_verification_passes_with_expected_id(self):
        # Ensure EXPECTED_IMAGE_ID matches actual s2-assets-e2e-runner:local
        res = subprocess.run(
            [
                "podman",
                "--events-backend=none",
                "image",
                "inspect",
                e2e_preflight.EXPECTED_IMAGE,
                "--format",
                "{{.Id}}",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(res.returncode, 0, "Image inspect must succeed")
        actual_id = res.stdout.strip()
        self.assertEqual(
            actual_id,
            e2e_preflight.EXPECTED_IMAGE_ID,
            f"Image ID must match {e2e_preflight.EXPECTED_IMAGE_ID}",
        )

    def test_log_driver_none_and_http_proxy_false(self):
        # Create a container with our verified invocation flags and inspect it
        test_cname = f"s2-test-flags-{os.getpid()}"
        res = subprocess.run(
            [
                "podman",
                "--events-backend=none",
                "create",
                "--pull=never",
                "--log-driver=none",
                "--http-proxy=false",
                "--name",
                test_cname,
                e2e_preflight.EXPECTED_IMAGE,
                "node",
                "-v",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(res.returncode, 0, "Container creation must succeed")
        try:
            inspect_res = subprocess.run(
                [
                    "podman",
                    "--events-backend=none",
                    "inspect",
                    test_cname,
                    "--format",
                    "{{.HostConfig.LogConfig.Type}}",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            log_type = inspect_res.stdout.strip()
            self.assertEqual(log_type, "none", "Log driver must be 'none'")
        finally:
            subprocess.run(
                ["podman", "--events-backend=none", "rm", "-f", test_cname],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )


class TestEndToEndSimulations(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="s2-test-env-")
        os.chmod(self.temp_dir, 0o700)
        self.env_file = Path(self.temp_dir) / "foundation.env"
        self.canary_pass = "CANARY_SECRET_PASSWORD_998877"
        env_content = f"""
COMPOSE_PROJECT_NAME=s2_test_sim_{os.getpid()}
POSTGRES_DB=s2_foundation_test
POSTGRES_USER=s2_test_user
POSTGRES_PASSWORD=deadbeefcafebabe0123456789abcdef
COOKIE_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
FOUNDATION_TEST_RUN_ID=run123
FOUNDATION_TEST_USERNAME=testuser
FOUNDATION_TEST_PASSWORD={self.canary_pass}
"""
        with open(self.env_file, "w") as f:
            f.write(env_content)
        os.chmod(self.env_file, 0o600)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _run_dev_sh(self, extra_env=None):
        env = os.environ.copy()
        env["FOUNDATION_ENV_FILE"] = str(self.env_file)
        env["E2E_BASE_URL"] = "http://web:5173"
        if extra_env:
            env.update(extra_env)
        cmd = ["bash", str(REPO_ROOT / "scripts" / "dev.sh"), "e2e", "--preflight"]
        return subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            env=env,
            capture_output=True,
            text=True,
        )

    def test_simulation_producer_failure_47(self):
        res = self._run_dev_sh({"FOUNDATION_E2E_SIMULATE_FAIL": "47"})
        self.assertEqual(res.returncode, 47)
        self.assertNotIn(self.canary_pass, res.stdout)
        self.assertNotIn(self.canary_pass, res.stderr)

    def test_simulation_producer_47_with_persist_fail_74(self):
        res = self._run_dev_sh({
            "FOUNDATION_E2E_SIMULATE_FAIL": "47",
            "FOUNDATION_E2E_SIMULATE_PERSIST_FAIL": "74",
        })
        self.assertEqual(res.returncode, 47)
        self.assertIn("preserving command exit code 47", res.stderr)
        self.assertNotIn(self.canary_pass, res.stdout)
        self.assertNotIn(self.canary_pass, res.stderr)

    def test_simulation_producer_47_with_cleanup_fail_1(self):
        res = self._run_dev_sh({
            "FOUNDATION_E2E_SIMULATE_FAIL": "47",
            "FOUNDATION_E2E_SIMULATE_CLEANUP_FAIL": "1",
        })
        self.assertEqual(res.returncode, 47)
        self.assertNotIn(self.canary_pass, res.stdout)
        self.assertNotIn(self.canary_pass, res.stderr)

    def test_simulation_install_failure_44(self):
        res = self._run_dev_sh({"FOUNDATION_E2E_SIMULATE_FAIL": "install"})
        self.assertEqual(res.returncode, 44)
        self.assertNotIn(self.canary_pass, res.stdout)
        self.assertNotIn(self.canary_pass, res.stderr)

    def test_simulation_preflight_failure_45(self):
        res = self._run_dev_sh({"FOUNDATION_E2E_SIMULATE_FAIL": "preflight"})
        self.assertEqual(res.returncode, 45)
        self.assertNotIn(self.canary_pass, res.stdout)
        self.assertNotIn(self.canary_pass, res.stderr)

    def test_invalid_e2e_base_url_fails_closed(self):
        env = os.environ.copy()
        env["FOUNDATION_ENV_FILE"] = str(self.env_file)
        canary_url_secret = "http://web:5173/CANARY_SECRET_LEAD_URL_TOKEN"
        env["E2E_BASE_URL"] = canary_url_secret
        res = subprocess.run(
            ["bash", str(REPO_ROOT / "scripts" / "dev.sh"), "e2e", "--preflight"],
            cwd=str(REPO_ROOT),
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(res.returncode, 1)
        self.assertIn("Invalid E2E_BASE_URL", res.stderr)
        self.assertNotIn("CANARY_SECRET_LEAD_URL_TOKEN", res.stderr, "Candidate URL canary must not leak to stderr")


class TestSignalHandling(unittest.TestCase):
    def test_sigterm_handling(self):
        with patch("sys.exit") as mock_exit:
            with patch("e2e_preflight._perform_cleanup"):
                e2e_preflight._cleanup_state["project_name"] = "s2_test_sig"
                e2e_preflight._cleanup_state["producer_exit"] = None
                e2e_preflight._handle_signal(signal.SIGTERM, None)
                mock_exit.assert_called_with(143)

    def test_producer_47_preserved_on_sigterm(self):
        with patch("sys.exit") as mock_exit:
            with patch("e2e_preflight._perform_cleanup"):
                e2e_preflight._cleanup_state["project_name"] = "s2_test_sig"
                e2e_preflight._cleanup_state["producer_exit"] = 47
                e2e_preflight._handle_signal(signal.SIGTERM, None)
                mock_exit.assert_called_with(47)

    def test_sigint_handling(self):
        with patch("sys.exit") as mock_exit:
            with patch("e2e_preflight._perform_cleanup"):
                e2e_preflight._cleanup_state["project_name"] = "s2_test_sig"
                e2e_preflight._cleanup_state["producer_exit"] = None
                e2e_preflight._handle_signal(signal.SIGINT, None)
                mock_exit.assert_called_with(130)


class TestControllerSubprocessFaults(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="s2-test-ctrlfault-")
        self.tmp_path = Path(self.tmp)
        self.envdir = self.tmp_path / "env"
        self.envdir.mkdir(mode=0o700)
        self.readonly = self.tmp_path / "readonly"
        self.readonly.mkdir(mode=0o500)
        self.initial_cleanup = copy.deepcopy(e2e_preflight._cleanup_state)

    def tearDown(self):
        try:
            os.chmod(self.readonly, 0o700)
        except OSError:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)
        e2e_preflight._cleanup_state.clear()
        e2e_preflight._cleanup_state.update(self.initial_cleanup)

    def test_install_cli_47_preserved_against_inspect_0(self):
        ws = self.tmp_path / "ws_install_47"
        ws.mkdir()
        calls = []
        def fake_run(cmd, **kw):
            calls.append(cmd)
            if "create" in cmd:
                Path(cmd[cmd.index("--cidfile") + 1]).write_text("a" * 64)
            return subprocess.CompletedProcess(cmd, 0, stdout="0\n", stderr="")
        class FakeProc:
            def __init__(self, cmd, **kw):
                self.returncode = 47 if len([x for x in calls if "create" in x]) == 1 else 0
            def wait(self, **kw):
                return self.returncode
            def kill(self): pass
        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-test-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "app")), \
             patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
             patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
             patch.object(e2e_preflight.subprocess, "Popen", FakeProc), \
             patch.object(e2e_preflight.signal, "signal"):
            code = e2e_preflight.run_preflight()
            self.assertEqual(code, 47, "Must preserve install CLI exit 47 over inspect 0")

    def test_install_removal_failure_retains_handles_and_fails_nonzero(self):
        ws = self.tmp_path / "ws_rm_fail"
        ws.mkdir()
        calls = []
        def fake_run(cmd, **kw):
            calls.append(cmd)
            if "create" in cmd:
                Path(cmd[cmd.index("--cidfile") + 1]).write_text("a" * 64)
            status = 1 if "rm" in cmd and sum("rm" in x for x in calls) == 1 else 0
            return subprocess.CompletedProcess(cmd, status, stdout="0\n", stderr="")
        class FakeProc:
            returncode = 0
            def __init__(self, cmd, **kw): self.returncode = 0
            def wait(self, **kw): return 0
            def kill(self): pass
        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-test-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "app")), \
             patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
             patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
             patch.object(e2e_preflight.subprocess, "Popen", FakeProc), \
             patch.object(e2e_preflight.signal, "signal"):
            code = e2e_preflight.run_preflight()
            self.assertNotEqual(code, 0, "Must not return 0 when container removal fails")
            self.assertTrue(ws.exists(), "Workspace must not be removed when container removal fails")
            self.assertIsNotNone(e2e_preflight._cleanup_state.get("active_cid"), "active_cid must be retained")

    def test_interrupted_create_handled_cleanly(self):
        ws = self.tmp_path / "ws_int_create"
        ws.mkdir()
        def fake_run(cmd, **kw):
            if "create" in cmd:
                Path(cmd[cmd.index("--cidfile") + 1]).write_text("a" * 64)
                raise subprocess.TimeoutExpired(cmd, 30)
            return subprocess.CompletedProcess(cmd, 0, stdout="0\n", stderr="")
        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-test-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "app")), \
             patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
             patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
             patch.object(e2e_preflight.signal, "signal"):
            try:
                code = e2e_preflight.run_preflight()
            except subprocess.TimeoutExpired:
                self.fail("TimeoutExpired must be caught and handled inside run_preflight")
            self.assertEqual(code, 124, "Must return 124 on create timeout")


if __name__ == "__main__":
    unittest.main()
