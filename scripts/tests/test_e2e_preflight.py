#!/usr/bin/env python3
"""Focused regression test suite for T046 trusted structured diagnostics and preflight."""

import contextlib
import copy
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch
import uuid

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
            # Verify required manifests are copied, but src/ is not copied
            self.assertTrue((ws / "apps" / "web" / "package.json").is_file())
            self.assertFalse((ws / "apps" / "web" / "src").exists(), "src/ must not be copied (exact allowlist, no src walk)")
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
        e2e_preflight._cleanup_state["signal_received"] = 0
        e2e_preflight._cleanup_state["producer_exit"] = None
        e2e_preflight._handle_signal(signal.SIGTERM, None)
        self.assertEqual(e2e_preflight._cleanup_state["signal_received"], signal.SIGTERM)
        self.assertEqual(
            e2e_preflight.resolve_exit_code(
                producer_exit=e2e_preflight._cleanup_state["producer_exit"],
                signal_received=e2e_preflight._cleanup_state["signal_received"],
            ),
            143,
        )

    def test_producer_47_preserved_on_sigterm(self):
        e2e_preflight._cleanup_state["signal_received"] = 0
        e2e_preflight._cleanup_state["producer_exit"] = 47
        e2e_preflight._handle_signal(signal.SIGTERM, None)
        self.assertEqual(e2e_preflight._cleanup_state["signal_received"], signal.SIGTERM)
        self.assertEqual(
            e2e_preflight.resolve_exit_code(
                producer_exit=e2e_preflight._cleanup_state["producer_exit"],
                signal_received=e2e_preflight._cleanup_state["signal_received"],
            ),
            47,
        )

    def test_sigint_handling(self):
        e2e_preflight._cleanup_state["signal_received"] = 0
        e2e_preflight._cleanup_state["producer_exit"] = None
        e2e_preflight._handle_signal(signal.SIGINT, None)
        self.assertEqual(e2e_preflight._cleanup_state["signal_received"], signal.SIGINT)
        self.assertEqual(
            e2e_preflight.resolve_exit_code(
                producer_exit=e2e_preflight._cleanup_state["producer_exit"],
                signal_received=e2e_preflight._cleanup_state["signal_received"],
            ),
            130,
        )


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
                self.cmd = cmd
                if "inspect" in cmd:
                    self.returncode = 0
                    self.stdout = io.BytesIO(f"{e2e_preflight._cleanup_state.get('inv_id', '')}\n".encode())
                else:
                    self.returncode = 47 if len([x for x in calls if "create" in x]) == 1 else 0
                    self.stdout = io.BytesIO(b"")
            def poll(self):
                return self.returncode
            def wait(self, **kw):
                return self.returncode
            def kill(self): pass
        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-test-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "s2-test-probe_default")), \
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
            def __init__(self, cmd, **kw):
                self.cmd = cmd
                self.returncode = 0
                if "inspect" in cmd:
                    self.stdout = io.BytesIO(f"{e2e_preflight._cleanup_state.get('inv_id', '')}\n".encode())
                else:
                    self.stdout = io.BytesIO(b"")
            def poll(self):
                return self.returncode
            def wait(self, **kw): return 0
            def kill(self): pass
        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-test-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "s2-test-probe_default")), \
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


class TestRound2SupervisionAndSecurityRegressions(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="s2-test-r2-")
        self.tmp_path = Path(self.temp_dir)
        self.envdir = self.tmp_path / "env"
        self.envdir.mkdir(mode=0o700)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_quiet_cli_deadline_respected(self):
        start = time.monotonic()
        rc, out = e2e_preflight._run_bounded(
            [sys.executable, "-c", "import time; time.sleep(1.25)"],
            timeout=0.05,
        )
        elapsed = time.monotonic() - start
        self.assertLess(elapsed, 0.5, "Monotonic deadline must cover quiet child reading")
        self.assertNotEqual(rc, 0, "Timed out child must return non-zero (124)")

    def test_nested_metadata_excluded_from_workspace(self):
        source = self.tmp_path / "src_meta"
        (source / "apps" / "web" / "src" / ".agents").mkdir(parents=True)
        (source / "scripts").mkdir()
        shutil.copy2(REPO_ROOT / "pnpm-lock.yaml", source / "pnpm-lock.yaml")
        shutil.copy2(REPO_ROOT / "scripts" / "e2e_preflight.mjs", source / "scripts" / "e2e_preflight.mjs")
        (source / "apps" / "web" / "package.json").write_text('{"name":"web"}')
        (source / "apps" / "web" / "src" / ".agents" / "config").write_text("LEAD_SYNTHETIC_NESTED_SECRET")
        ws = e2e_preflight.setup_workspace(source)
        try:
            self.assertFalse((ws / "apps" / "web" / "src" / ".agents" / "config").exists())
        finally:
            shutil.rmtree(ws, ignore_errors=True)

    def test_symlink_ancestor_rejected(self):
        second = self.tmp_path / "src_symlink"
        (second / "apps").mkdir(parents=True)
        (second / "scripts").mkdir()
        shutil.copy2(REPO_ROOT / "pnpm-lock.yaml", second / "pnpm-lock.yaml")
        shutil.copy2(REPO_ROOT / "scripts" / "e2e_preflight.mjs", second / "scripts" / "e2e_preflight.mjs")
        external = self.tmp_path / "external-web"
        external.mkdir()
        (external / "package.json").write_text('{"canary":"LEAD_SYNTHETIC_EXTERNAL_SECRET"}')
        (second / "apps" / "web").symlink_to(external, target_is_directory=True)
        with self.assertRaises(SystemExit):
            e2e_preflight.setup_workspace(second)

    def test_duplicate_keys_in_control_json_rejected(self):
        ctrl = self.tmp_path / "dup.json"
        raw = '{"protocol":"s2_e2e_preflight_v1","invocation_id":"inv-dup","status":"fail","status":"pass"}'
        ctrl.write_text(raw)
        ok, msg = e2e_preflight.validate_control_response(ctrl, expected_inv_id="inv-dup")
        self.assertFalse(ok, "Control response with duplicate keys must be rejected")

    def test_foreign_label_zero_rejected(self):
        cidfile = self.tmp_path / "foreign.cid"
        cidfile.write_text("c" * 64)
        with patch.object(e2e_preflight, "_run_bounded", return_value=(0, "0\n")):
            res = e2e_preflight._reconcile_container(str(cidfile), "foreign", "inv-expected")
            self.assertIsNone(res, "Label 0 must not be accepted as matching inv-expected")

    def test_ownership_inspection_failure_rejected(self):
        cidfile = self.tmp_path / "foreign2.cid"
        cidfile.write_text("c" * 64)
        with patch.object(e2e_preflight, "_run_bounded", return_value=(125, "")):
            res = e2e_preflight._reconcile_container(str(cidfile), "foreign", "inv-expected")
            self.assertIsNone(res, "Inspection failure (rc 125) must not accept CID")

    def test_wrong_application_network_rejected(self):
        def network_reply(cmd, **kw):
            if "ps" in cmd:
                return 0, "d" * 12 + "\n"
            return 0, "s2-probe_other s2-probe_default\n"
        with patch.object(e2e_preflight, "_run_bounded", side_effect=network_reply):
            _, net = e2e_preflight.resolve_web_and_network("s2-probe")
            self.assertEqual(net, "s2-probe_default", "Must select exact application network s2-probe_default")

    def test_failed_rootless_inspection_fails_closed(self):
        def image_reply(cmd, **kw):
            return (125, "") if "info" in cmd else (0, e2e_preflight.EXPECTED_IMAGE_ID)
        with patch.object(e2e_preflight, "_run_bounded", side_effect=image_reply):
            with self.assertRaises(SystemExit):
                e2e_preflight.verify_image()

    def test_signal_during_create_retains_handles_and_records_cid(self):
        ws = self.tmp_path / "signal-ws"
        ws.mkdir()
        cidfile = self.tmp_path / "pending.cid"
        cidfile.write_text("e" * 64)
        recovery = self.tmp_path / "signal-recovery.log"
        e2e_preflight._cleanup_state.update(
            active_workspace=str(ws),
            active_cidfile=str(cidfile),
            active_cid=None,
            recovery_log_path=str(recovery),
            project_name="s2-probe",
            cleanup_failed=False,
            signal_received=0,
        )
        e2e_preflight._handle_signal(signal.SIGTERM, None)
        self.assertEqual(e2e_preflight._cleanup_state["signal_received"], signal.SIGTERM)
        # In Round 3, cleanup & recovery commit are executed by supervisor on latched signal
        e2e_preflight._perform_cleanup()
        rec_info = e2e_preflight.format_recovery_info(
            exit_status=143,
            trap_signal=143,
            cleanup_failed=e2e_preflight._cleanup_state["cleanup_failed"],
            project_name="s2-probe",
            unremoved_cid=e2e_preflight._cleanup_state.get("active_cid"),
            unremoved_workspace=e2e_preflight._cleanup_state.get("active_workspace"),
        )
        e2e_preflight.commit_recovery(str(recovery), rec_info)
        self.assertTrue(ws.exists(), "Workspace must not be deleted when unreconciled CID exists")
        self.assertTrue(cidfile.exists(), "CID file must not be deleted when unreconciled CID exists")
        self.assertTrue(recovery.exists(), "Recovery log must be committed on signal")
        self.assertIn("e" * 64, recovery.read_text(), "Unreconciled CID must appear in recovery log")
        self.assertTrue(e2e_preflight._cleanup_state["cleanup_failed"])

    def test_start_timeout_handled_cleanly(self):
        ws = self.tmp_path / "ws_start_timeout"
        ws.mkdir()
        def fake_run(cmd, **kw):
            if "create" in cmd:
                Path(cmd[cmd.index("--cidfile") + 1]).write_text("a" * 64)
            if "start" in cmd:
                raise subprocess.TimeoutExpired(cmd, 15)
            return subprocess.CompletedProcess(cmd, 0)
        def metadata(cmd, **kw):
            if any("io.s2-assets.invocation-id" in str(s) for s in cmd):
                return 0, e2e_preflight._cleanup_state["inv_id"]
            return 0, ""
        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "s2-probe_default")), \
             patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
             patch.object(e2e_preflight, "_run_bounded", side_effect=metadata), \
             patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
             patch.object(e2e_preflight.signal, "signal"):
            try:
                code = e2e_preflight.run_preflight()
            except subprocess.TimeoutExpired:
                self.fail("TimeoutExpired on start must be handled within run_preflight")
            self.assertEqual(code, 124, "Must return 124 on start timeout")

    def test_producer_47_preserved_on_rm_timeout(self):
        ws = self.tmp_path / "ws_rm_timeout"
        ws.mkdir()
        calls = []
        def fake_run(cmd, **kw):
            calls.append(cmd)
            if "create" in cmd:
                Path(cmd[cmd.index("--cidfile") + 1]).write_text("a" * 64)
            if "rm" in cmd:
                raise subprocess.TimeoutExpired(cmd, 10)
            return subprocess.CompletedProcess(cmd, 0)
        def metadata(cmd, **kw):
            if any("io.s2-assets.invocation-id" in str(s) for s in cmd):
                return 0, e2e_preflight._cleanup_state["inv_id"]
            return 0, "false 47"
        class FakeWait:
            returncode = 0
            def __init__(self, *a, **k):
                self.returncode = 0
            def wait(self, **k): return 0
            def kill(self): pass
        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "s2-probe_default")), \
             patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
             patch.object(e2e_preflight, "_run_bounded", side_effect=metadata), \
             patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
             patch.object(e2e_preflight.subprocess, "Popen", FakeWait), \
             patch.object(e2e_preflight.signal, "signal"):
            try:
                code = e2e_preflight.run_preflight()
            except subprocess.TimeoutExpired:
                self.fail("TimeoutExpired on rm must be caught")
            self.assertEqual(code, 47, "Must preserve producer exit 47 when rm times out")

    def test_malformed_terminal_state_fails_closed(self):
        ws = self.tmp_path / "ws_malformed"
        ws.mkdir()
        def fake_run(cmd, **kw):
            if "create" in cmd:
                Path(cmd[cmd.index("--cidfile") + 1]).write_text("a" * 64)
            return subprocess.CompletedProcess(cmd, 0)
        def metadata(cmd, **kw):
            if any("io.s2-assets.invocation-id" in str(s) for s in cmd):
                return 0, e2e_preflight._cleanup_state["inv_id"]
            return 0, "garbage"
        class FakeWait:
            def __init__(self, *a, **k): pass
            def wait(self, **k): return 0
            def kill(self): pass
        out = io.StringIO()
        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "s2-probe_default")), \
             patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
             patch.object(e2e_preflight, "_run_bounded", side_effect=metadata), \
             patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
             patch.object(e2e_preflight.subprocess, "Popen", FakeWait), \
             patch.object(e2e_preflight.signal, "signal"), \
             contextlib.redirect_stdout(out):
            code = e2e_preflight.run_preflight()
            self.assertNotEqual(code, 0, "Malformed terminal state must fail closed")
            self.assertNotIn("Playwright runtime preflight verified:", out.getvalue())

    def test_installation_replaces_assertions_fails_closed(self):
        ws = self.tmp_path / "ws_tamper"
        ws.mkdir()
        (ws / "e2e_preflight.mjs").write_text("reviewed")
        calls = []
        def fake_run(cmd, **kw):
            calls.append(cmd)
            if "create" in cmd:
                phase = sum("create" in c for c in calls)
                Path(cmd[cmd.index("--cidfile") + 1]).write_text("a" * 64)
                if phase == 1:
                    (ws / "e2e_preflight.mjs").write_text("forged replacement")
            return subprocess.CompletedProcess(cmd, 0)
        def metadata(cmd, **kw):
            if any("io.s2-assets.invocation-id" in str(s) for s in cmd):
                return 0, e2e_preflight._cleanup_state["inv_id"]
            return 0, "false 0"
        class FakeWait:
            def __init__(self, *a, **k): pass
            def wait(self, **k): return 0
            def kill(self): pass
        out = io.StringIO()
        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "s2-probe_default")), \
             patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
             patch.object(e2e_preflight, "_run_bounded", side_effect=metadata), \
             patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
             patch.object(e2e_preflight.subprocess, "Popen", FakeWait), \
             patch.object(e2e_preflight.signal, "signal"), \
             contextlib.redirect_stdout(out):
            code = e2e_preflight.run_preflight()
            self.assertNotEqual(code, 0, "Altered assertion script during install must fail closed")
            self.assertNotIn("Playwright runtime preflight verified:", out.getvalue())


class TestRound3PhaseARegressions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="s2-test-r3-")
        self.tmp_path = Path(self.tmp)
        self.envdir = self.tmp_path / "env"
        self.envdir.mkdir(mode=0o700)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        e2e_preflight._reset_cleanup_state()

    def test_quiet_child_terminates_within_monotonic_deadline(self):
        t = time.monotonic()
        rc, out = e2e_preflight._run_bounded(
            [sys.executable, "-c", "import time; time.sleep(1.25)"],
            timeout=0.05,
        )
        elapsed = time.monotonic() - t
        self.assertEqual(rc, 124, "Quiet child must return 124 on timeout")
        self.assertLess(elapsed, 0.25, f"Deadline must be respected (elapsed: {elapsed}s)")

    def test_nonallowlisted_sensitive_copy_prevented(self):
        source = self.tmp_path / "source"
        (source / "apps" / "web" / "src" / "cache").mkdir(parents=True)
        (source / "scripts").mkdir()
        shutil.copy2(REPO_ROOT / "pnpm-lock.yaml", source / "pnpm-lock.yaml")
        shutil.copy2(REPO_ROOT / "scripts" / "e2e_preflight.mjs", source / "scripts" / "e2e_preflight.mjs")
        (source / "apps" / "web" / "package.json").write_text('{"name":"web"}')
        (source / "apps" / "web" / "src" / "credentials.json").write_text("SYNTHETIC_CREDENTIAL")
        (source / "apps" / "web" / "src" / "cache" / "session").write_text("SYNTHETIC_CACHED_SECRET")

        ws = e2e_preflight.setup_workspace(source)
        try:
            self.assertFalse((ws / "apps" / "web" / "src" / "credentials.json").exists())
            self.assertFalse((ws / "apps" / "web" / "src" / "cache" / "session").exists())
            self.assertFalse((ws / "apps" / "web" / "src").exists())
        finally:
            shutil.rmtree(ws, ignore_errors=True)

    def test_checked_path_swap_prevented(self):
        source = self.tmp_path / "source_swap"
        (source / "apps" / "web").mkdir(parents=True)
        (source / "scripts").mkdir()
        shutil.copy2(REPO_ROOT / "pnpm-lock.yaml", source / "pnpm-lock.yaml")
        shutil.copy2(REPO_ROOT / "scripts" / "e2e_preflight.mjs", source / "scripts" / "e2e_preflight.mjs")
        pkg = source / "apps" / "web" / "package.json"
        pkg.write_text('{"name":"web"}')
        external = self.tmp_path / "external-secret"
        external.write_text("SYNTHETIC_RACE_SECRET")

        original_copy2 = shutil.copy2
        def swap_copy(src, dst, *a, **kw):
            if Path(src) == pkg:
                pkg.unlink()
                pkg.symlink_to(external)
            return original_copy2(src, dst, *a, **kw)

        with patch.object(e2e_preflight.shutil, "copy2", side_effect=swap_copy):
            ws = e2e_preflight.setup_workspace(source)
        try:
            copied_text = (ws / "apps" / "web" / "package.json").read_text("utf-8")
            self.assertNotIn("SYNTHETIC_RACE_SECRET", copied_text)
            self.assertIn("web", copied_text)
        finally:
            shutil.rmtree(ws, ignore_errors=True)

    def test_name_rejected_without_full_cid(self):
        with patch.object(e2e_preflight, "_run_bounded", return_value=(0, "inv-exact")):
            cid = e2e_preflight._reconcile_container(str(self.tmp_path / "missing.cid"), "some-name", "inv-exact")
            self.assertIsNone(cid, "Must not accept container name as CID")

    def test_bare_zero_terminal_state_rejected(self):
        valid, exit_code = e2e_preflight._parse_terminal_state("0")
        self.assertFalse(valid, "Bare '0' inspect must be rejected")
        self.assertIsNone(exit_code)

    def test_nonboolean_terminal_state_rejected(self):
        valid, exit_code = e2e_preflight._parse_terminal_state("garbage 0 ignored-extra")
        self.assertFalse(valid, "Non-boolean or multi-token inspect must be rejected")
        self.assertIsNone(exit_code)

    def test_create_timeout_without_cid_retains_workspace(self):
        ws = self.tmp_path / "ws_timeout"
        ws.mkdir()
        def fake_run(cmd, **kw):
            if "create" in cmd:
                raise subprocess.TimeoutExpired(cmd, 30)
            return subprocess.CompletedProcess(cmd, 0)
        def metadata(cmd, **kw):
            return 125, ""

        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "s2-probe_default")), \
             patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
             patch.object(e2e_preflight, "_run_bounded", side_effect=metadata), \
             patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
             patch.object(e2e_preflight.signal, "signal"):
            code = e2e_preflight.run_preflight()
            self.assertEqual(code, 124)
            self.assertTrue(ws.exists(), "Uncertain create timeout must retain workspace")
            self.assertTrue(e2e_preflight._cleanup_state["cleanup_failed"])

    def test_producer_47_preserved_across_sigterm(self):
        ws = self.tmp_path / "ws_sigterm"
        ws.mkdir()
        (ws / ".control").mkdir()
        calls = []
        def fake_run(cmd, **kw):
            calls.append(cmd)
            if "create" in cmd:
                Path(cmd[cmd.index("--cidfile") + 1]).write_text("a" * 64)
            if "rm" in cmd:
                os.kill(os.getpid(), signal.SIGTERM)
            return subprocess.CompletedProcess(cmd, 0)
        def metadata(cmd, **kw):
            if any("io.s2-assets.invocation-id" in str(s) for s in cmd):
                return 0, e2e_preflight._cleanup_state["inv_id"]
            return 0, "false 47"
        class FakeWait:
            def __init__(self, *a, **k): pass
            def wait(self, **k): return 0
            def kill(self): pass

        old_term = signal.getsignal(signal.SIGTERM)
        try:
            with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-probe", "ENV_DIR": str(self.envdir)}), \
                 patch.object(e2e_preflight, "verify_image"), \
                 patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "s2-probe_default")), \
                 patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
                 patch.object(e2e_preflight, "_run_bounded", side_effect=metadata), \
                 patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
                 patch.object(e2e_preflight.subprocess, "Popen", FakeWait):
                code = e2e_preflight.run_preflight()
                self.assertEqual(code, 47, "Producer 47 must be preserved across SIGTERM")
                self.assertEqual(e2e_preflight._cleanup_state["producer_exit"], 47)
        finally:
            signal.signal(signal.SIGTERM, old_term)

    def test_producer_47_preserved_across_sigint(self):
        ws = self.tmp_path / "ws_sigint"
        ws.mkdir()
        (ws / ".control").mkdir()
        calls = []
        def fake_run(cmd, **kw):
            calls.append(cmd)
            if "create" in cmd:
                Path(cmd[cmd.index("--cidfile") + 1]).write_text("a" * 64)
            if "rm" in cmd:
                os.kill(os.getpid(), signal.SIGINT)
            return subprocess.CompletedProcess(cmd, 0)
        def metadata(cmd, **kw):
            if any("io.s2-assets.invocation-id" in str(s) for s in cmd):
                return 0, e2e_preflight._cleanup_state["inv_id"]
            return 0, "false 47"
        class FakeWait:
            def __init__(self, *a, **k): pass
            def wait(self, **k): return 0
            def kill(self): pass

        old_int = signal.getsignal(signal.SIGINT)
        try:
            with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-probe", "ENV_DIR": str(self.envdir)}), \
                 patch.object(e2e_preflight, "verify_image"), \
                 patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "s2-probe_default")), \
                 patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
                 patch.object(e2e_preflight, "_run_bounded", side_effect=metadata), \
                 patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
                 patch.object(e2e_preflight.subprocess, "Popen", FakeWait):
                code = e2e_preflight.run_preflight()
                self.assertEqual(code, 47, "Producer 47 must be preserved across SIGINT")
                self.assertEqual(e2e_preflight._cleanup_state["producer_exit"], 47)
        finally:
            signal.signal(signal.SIGINT, old_int)

    def test_config_tampered_during_install_fails_closed(self):
        ws = self.tmp_path / "ws_cfg_tamper"
        ws.mkdir()
        (ws / "apps" / "web").mkdir(parents=True)
        (ws / "apps" / "web" / "playwright.config.ts").write_text("reviewed")
        calls = []
        def fake_run(cmd, **kw):
            calls.append(cmd)
            if "create" in cmd:
                phase = sum("create" in c for c in calls)
                Path(cmd[cmd.index("--cidfile") + 1]).write_text("a" * 64)
                if phase == 1:
                    (ws / "apps" / "web" / "playwright.config.ts").write_text("unreviewed config")
            return subprocess.CompletedProcess(cmd, 0)
        def metadata(cmd, **kw):
            if any("io.s2-assets.invocation-id" in str(s) for s in cmd):
                return 0, e2e_preflight._cleanup_state["inv_id"]
            return 0, "false 0"
        class FakeWait:
            def __init__(self, *a, **k): pass
            def wait(self, **k): return 0
            def kill(self): pass

        out = io.StringIO()
        with patch.object(e2e_preflight, "validate_environment", return_value={"COMPOSE_PROJECT_NAME": "s2-probe", "ENV_DIR": str(self.envdir)}), \
             patch.object(e2e_preflight, "verify_image"), \
             patch.object(e2e_preflight, "resolve_web_and_network", return_value=("web", "s2-probe_default")), \
             patch.object(e2e_preflight, "setup_workspace", return_value=ws), \
             patch.object(e2e_preflight, "_run_bounded", side_effect=metadata), \
             patch.object(e2e_preflight.subprocess, "run", side_effect=fake_run), \
             patch.object(e2e_preflight.subprocess, "Popen", FakeWait), \
             patch.object(e2e_preflight.signal, "signal"), \
             contextlib.redirect_stdout(out):
            code = e2e_preflight.run_preflight()
            self.assertEqual(code, 1, "Config tampered during install must fail closed")
            self.assertNotIn("Playwright runtime preflight verified:", out.getvalue())

    def test_real_imported_config_forgery_fails_closed(self):
        # Verify in actual runtime container that forged config fails closed
        runtime = self.tmp_path / "runtime"
        (runtime / "apps" / "web" / "node_modules" / "@playwright" / "test").mkdir(parents=True)
        (runtime / ".control").mkdir()
        shutil.copy2(REPO_ROOT / "scripts" / "e2e_preflight.mjs", runtime / "e2e_preflight.mjs")
        (runtime / "apps" / "web" / "package.json").write_text(json.dumps({
            "name": "web",
            "type": "module",
            "scripts": {"test:e2e": "playwright test"},
            "devDependencies": {"@playwright/test": "1.63.0"},
        }))
        (runtime / "apps" / "web" / "node_modules" / "@playwright" / "test" / "package.json").write_text('{"version":"1.63.0"}')
        inv = f"test-forgery-{uuid.uuid4().hex}"
        forged_config = (
            "import fs from 'node:fs';\n"
            "process.exit(0);\n"
        )
        (runtime / "apps" / "web" / "playwright.config.ts").write_text(forged_config)
        cname = f"s2-test-forgery-{uuid.uuid4().hex[:8]}"
        cid = None
        try:
            r = subprocess.run(
                [
                    "podman", "--events-backend=none", "create",
                    "--name", cname, "--pull=never", "--network=none",
                    "--log-driver=none", "--http-proxy=false",
                    "-v", f"{runtime}:/workspace:z",
                    "-w", "/workspace",
                    "-e", "HOME=/tmp",
                    "-e", f"E2E_INVOCATION_ID={inv}",
                    "-e", f"E2E_CONTROL_FILE=/workspace/.control/forged.json",
                    "-e", "E2E_BASE_URL=http://web:5173",
                    e2e_preflight.EXPECTED_IMAGE_ID,
                    "node", "/workspace/e2e_preflight.mjs",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=20,
            )
            if r.returncode == 0:
                cid = r.stdout.decode().strip()
                subprocess.run(["podman", "--events-backend=none", "start", cid], timeout=15)
                wait_res = subprocess.run(["podman", "--events-backend=none", "wait", cid], stdout=subprocess.PIPE, timeout=20)
                wait_code = int(wait_res.stdout.decode().strip())
                self.assertEqual(wait_code, 1, "Forged config must cause preflight script to exit 1")
                # Control response must be status: fail or not accepted
                ctrl_path = runtime / ".control" / "forged.json"
                if ctrl_path.exists():
                    ok, _ = e2e_preflight.validate_control_response(ctrl_path, expected_inv_id=inv)
                    self.assertFalse(ok, "Forged config must not produce an accepted pass control response")
        finally:
            if cid:
                subprocess.run(["podman", "--events-backend=none", "rm", "-f", "-t", "1", cid], timeout=10)


if __name__ == "__main__":
    unittest.main()
