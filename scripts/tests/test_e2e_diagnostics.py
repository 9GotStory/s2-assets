#!/usr/bin/env python3
"""Comprehensive unit, regression, and fault-injection test battery
for T046 [US4] Isolated Playwright Runtime Preflight byte-stream diagnostics.

Standard-library-only. Tests prior P1 defects, partition invariance,
conservative redaction, bounded I/O, fail-closed faults, and performance.
"""

import collections
import os
import random
import signal
import subprocess
import sys
import tempfile
import time
import unittest

# Ensure scripts directory is importable
SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

try:
    import e2e_diagnostics
except ImportError:
    e2e_diagnostics = None


def get_round4_embedded_code():
    try:
        out = subprocess.check_output(
            ["git", "show", "6ab4ed8246d94d95eb8d90c578060404605ae830:scripts/dev.sh"],
            cwd=SCRIPT_DIR,
            stderr=subprocess.DEVNULL,
            text=True
        )
        lines = out.splitlines(keepends=True)
        py_lines = lines[951:1238]
        return "".join(py_lines)
    except Exception:
        return ""


class TestRound4Vulnerabilities(unittest.TestCase):
    """Reproduces the three P1 defects directly on Round 4 candidate code."""

    def setUp(self):
        self.r4_code = get_round4_embedded_code()

    def test_reproduce_defect1_long_url_credential_leak(self):
        """P1 Defect 1: 200,000-char password leaks canary fragments past 2048 threshold."""
        canary_url = "postgres://user:CANARY_START_" + ("x" * 200000) + "_CANARY_END@db.internal:5432/mydb\n"
        p = subprocess.Popen(
            [sys.executable, "-c", self.r4_code, "", "filter"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        stdout, _ = p.communicate(input=canary_url)
        # Round 4 exited 0 and leaked canary markers
        self.assertEqual(p.returncode, 0)
        self.assertIn("CANARY_START_", stdout, "Round 4 leaked CANARY_START_")
        self.assertIn("_CANARY_END", stdout, "Round 4 leaked _CANARY_END")

    def test_reproduce_defect2_split_bearer_boundary_leak(self):
        """P1 Defect 2: Split Bearer with whitespace at 16,384 boundary leaks token."""
        p = subprocess.Popen(
            [sys.executable, "-c", self.r4_code, "", "filter"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        chunk1 = ("A" * (16384 - 7)) + "Bearer "
        chunk2 = "  SPLIT_BEARER_CANARY\n"
        p.stdin.write(chunk1 + chunk2)
        p.stdin.close()
        stdout = p.stdout.read()
        p.stdout.close()
        p.stderr.close()
        p.wait()
        self.assertEqual(p.returncode, 0)
        self.assertIn("SPLIT_BEARER_CANARY", stdout, "Round 4 leaked SPLIT_BEARER_CANARY")

    def test_reproduce_defect3_silent_io_failure(self):
        """P1 Defect 3: Non-writable directory silently returns exit code 0."""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.chmod(tmpdir, 0o500)
            target_log = os.path.join(tmpdir, "test.log")
            p = subprocess.Popen(
                [sys.executable, "-c", self.r4_code, target_log, "sink"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            p.communicate(input="diagnostic line\n")
            os.chmod(tmpdir, 0o700)
            # Round 4 swallowed the PermissionError and returned 0
            self.assertEqual(p.returncode, 0, "Round 4 silently returned 0 on I/O error")
            self.assertFalse(os.path.exists(target_log))


class TestByteStreamSanitizer(unittest.TestCase):
    """Unit and partition invariance tests for ByteStreamSanitizer."""

    def setUp(self):
        if e2e_diagnostics is None:
            self.skipTest("e2e_diagnostics module not yet available")
        self.san = e2e_diagnostics.ByteStreamSanitizer()

    def sanitize_all(self, data: bytes, chunk_size: int = 16384) -> bytes:
        self.san.reset()
        out = bytearray()
        for i in range(0, len(data), chunk_size):
            chunk = data[i:i + chunk_size]
            out.extend(self.san.feed(chunk))
        out.extend(self.san.finish())
        return bytes(out)

    def test_conservative_url_redaction(self):
        cases = [
            (b"http://localhost:5173", b"http://[REDACTED_URL]"),
            (b"https://example.com/api/v1?query=1#frag", b"https://[REDACTED_URL]"),
            (b"postgres://user:secret123@localhost:5432/db", b"postgres://[REDACTED_URL]"),
            (b"http://review-user:SYNTHETIC_CANARY@127.0.0.1:5173/login", b"http://[REDACTED_URL]"),
            (b"custom-scheme://any.host:8080/path", b"custom-scheme://[REDACTED_URL]"),
            (b"://just.scheme.less/url", b"://[REDACTED_URL]"),
            (b"ftp://u%40ser:p%40ss@ftp.example.com", b"ftp://[REDACTED_URL]"),
        ]
        for inp, expected in cases:
            res = self.sanitize_all(inp + b"\n")
            self.assertEqual(res, expected + b"\n", f"Failed for {inp}")
            self.assertNotIn(b"SYNTHETIC_CANARY", res)
            self.assertNotIn(b"secret123", res)

    def test_long_url_credential_no_leak(self):
        """Verify 200,000-character credential URL is completely redacted without canary leak."""
        long_pass = b"CANARY_START_" + (b"p" * 200000) + b"_CANARY_END"
        raw_url = b"postgres://user:" + long_pass + b"@db.internal:5432/production\n"
        res = self.sanitize_all(raw_url, chunk_size=16384)
        self.assertEqual(res, b"postgres://[REDACTED_URL]\n")
        self.assertNotIn(b"CANARY_START_", res)
        self.assertNotIn(b"_CANARY_END", res)

    def test_bearer_token_redaction(self):
        cases = [
            (b"Authorization: Bearer secret_token_123\n", b"Authorization: Bearer [REDACTED]\n"),
            (b"Authorization: Bearer   spaced_token_456\n", b"Authorization: Bearer   [REDACTED]\n"),
            (b"Authorization: Bearer\t\ttab_token_789\n", b"Authorization: Bearer\t\t[REDACTED]\n"),
            (b"Authorization: Bearer\r\n\tmultiline_token\n", b"Authorization: Bearer\r\n\t[REDACTED]\n"),
            (b'Authorization: Bearer "quoted_token_abc"\n', b'Authorization: Bearer "[REDACTED]"\n'),
            (b"Authorization: Bearer 'single_quoted_xyz'\n", b"Authorization: Bearer '[REDACTED]'\n"),
        ]
        for inp, expected in cases:
            res = self.sanitize_all(inp)
            self.assertEqual(res, expected, f"Failed for {inp}")
            self.assertNotIn(b"secret_token", res)
            self.assertNotIn(b"quoted_token", res)

    def test_split_bearer_boundary_invariance(self):
        """Verify that Bearer split across chunk boundaries never exposes token."""
        chunk1 = b"Prefix text... Bearer "
        chunk2 = b"  SPLIT_BEARER_CANARY\n"
        self.san.reset()
        out = self.san.feed(chunk1) + self.san.feed(chunk2) + self.san.finish()
        self.assertEqual(out, b"Prefix text... Bearer   [REDACTED]\n")
        self.assertNotIn(b"SPLIT_BEARER_CANARY", out)

    def test_named_assignments_redaction(self):
        keys = [
            b"COOKIE_SECRET",
            b"DATABASE_URL",
            b"POSTGRES_PASSWORD",
            b"TOKEN",
            b"KEY",
            b"SECRET",
            b"PASSWORD",
        ]
        for k in keys:
            # Unquoted
            raw = k + b"=super_secret_value_123\n"
            res = self.sanitize_all(raw)
            self.assertEqual(res, k + b"=[REDACTED]\n")
            self.assertNotIn(b"super_secret_value", res)

            # Lowercase key
            k_low = k.lower()
            raw_low = k_low + b"=secret_low\n"
            res_low = self.sanitize_all(raw_low)
            self.assertEqual(res_low, k_low + b"=[REDACTED]\n")
            self.assertNotIn(b"secret_low", res_low)

            # Leading whitespace before value
            raw_ws = k + b"=   space_secret\n"
            res_ws = self.sanitize_all(raw_ws)
            self.assertEqual(res_ws, k + b"=   [REDACTED]\n")

            # Quoted with escaped quotes
            raw_quote = k + b'="secret\\"with\\"escaped\\nquotes" remainder\n'
            res_quote = self.sanitize_all(raw_quote)
            self.assertEqual(res_quote, k + b'="[REDACTED]" remainder\n')
            self.assertNotIn(b"secret", res_quote)

            # Single quoted
            raw_sq = k + b"='single\\'quoted' remainder\n"
            res_sq = self.sanitize_all(raw_sq)
            self.assertEqual(res_sq, k + b"=\x27[REDACTED]\x27 remainder\n")
            self.assertNotIn(b"single", res_sq)

    def test_partition_invariance(self):
        """Verify chunk sizes 1, 7, 16384, and randomized partitions produce identical output."""
        corpus = (
            b"Log entry 1: normal message\n"
            b"Log entry 2: connecting to postgres://app_user:db_pass_12345@db.host:5432/app_db\n"
            b"Log entry 3: Authorization: Bearer    very_secret_jwt_token_canary\n"
            b"Log entry 4: env POSTGRES_PASSWORD=my_pg_super_secret_canary\n"
            b"Log entry 5: env COOKIE_SECRET=\"quoted_cookie_\\\"secret\\\"_canary\"\n"
            b"Log entry 6: env TOKEN='sq_token_canary'\n"
            b"Log entry 7: http://user:CANARY_PASS@web:5173/dashboard?token=query_canary#hash\n"
            b"Log entry 8: trailing normal text\n"
        )

        res_16k = self.sanitize_all(corpus, chunk_size=16384)
        res_7 = self.sanitize_all(corpus, chunk_size=7)
        res_1 = self.sanitize_all(corpus, chunk_size=1)

        self.assertEqual(res_16k, res_7, "Mismatch between 16k and 7 byte chunks")
        self.assertEqual(res_16k, res_1, "Mismatch between 16k and 1 byte chunks")

        # Randomized partitions
        rng = random.Random(42)
        for _ in range(5):
            idx = 0
            chunks = []
            while idx < len(corpus):
                step = rng.randint(1, 32)
                chunks.append(corpus[idx:idx + step])
                idx += step
            self.san.reset()
            res_rand = bytearray()
            for ch in chunks:
                res_rand.extend(self.san.feed(ch))
            res_rand.extend(self.san.finish())
            self.assertEqual(res_16k, bytes(res_rand), "Randomized chunk partition differed")

    def test_incomplete_prefix_eof(self):
        """Unfinished trigger prefix at EOF emits fixed redaction marker, never raw text."""
        prefixes = [b"POSTGRES_", b"COOKIE_", b"Bea", b":", b":/"]
        for p in prefixes:
            self.san.reset()
            out = self.san.feed(p) + self.san.finish()
            self.assertEqual(out, b"[REDACTED]", f"Incomplete prefix {p} at EOF did not emit marker")

    def test_unterminated_quote_eof(self):
        """Unterminated quote at EOF keeps secret suppressed."""
        raw = b'SECRET="unterminated_secret_value_at_eof'
        res = self.sanitize_all(raw)
        self.assertNotIn(b"unterminated_secret_value", res)

    def test_invalid_utf8_binary_bytes(self):
        """Sanitizer handles arbitrary non-UTF-8 binary bytes without crashing."""
        raw = b"\xff\xfe\x00\x01\x80\x81http://user:pass@host/path \xff\xfe\x00\x01\n"
        res = self.sanitize_all(raw)
        self.assertEqual(res, b"\xff\xfe\x00\x01\x80\x81http://[REDACTED_URL] \xff\xfe\x00\x01\n")


class TestBoundedDiagnosticWriter(unittest.TestCase):
    """Verifies bounded ring buffer, console limit, and atomic file commit."""

    def test_ring_buffer_byte_and_line_limits(self):
        buf = e2e_diagnostics.BoundedRingBuffer(max_bytes=100, max_lines=10)
        # Add 20 lines of 10 bytes each -> 200 bytes total
        for i in range(20):
            buf.append(f"line_{i:02d}___\n".encode("ascii"))

        out = buf.get_bytes()
        self.assertLessEqual(len(out), 100)
        self.assertLessEqual(len(out.splitlines()), 10)
        self.assertTrue(out.endswith(b"line_19___\n"))

    def test_3000_short_lines_bounded_artifact(self):
        """3,000 short lines must be strictly bounded to 51,200 bytes and 1,000 lines."""
        buf = e2e_diagnostics.BoundedRingBuffer(max_bytes=51200, max_lines=1000)
        for i in range(3000):
            buf.append(f"item {i}: short diagnostic message\n".encode("utf-8"))

        out = buf.get_bytes()
        self.assertLessEqual(len(out), 51200)
        self.assertLessEqual(len(out.splitlines()), 1000)
        self.assertTrue(out.endswith(b"item 2999: short diagnostic message\n"))

    def test_atomic_replace_and_permissions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            target_path = os.path.join(tmpdir, "audit.log")
            buf = e2e_diagnostics.BoundedRingBuffer(max_bytes=51200, max_lines=1000)
            buf.append(b"sanitized initial content\n")
            buf.write_to_disk_atomic(target_path)

            self.assertTrue(os.path.exists(target_path))
            mode = os.stat(target_path).st_mode & 0o777
            self.assertEqual(mode, 0o600)
            with open(target_path, "rb") as f:
                self.assertEqual(f.read(), b"sanitized initial content\n")


class TestDiagnosticFailClosedIO(unittest.TestCase):
    """Verifies real I/O failure handling, nonzero exit code 74, and safe recovery."""

    def test_cli_sink_on_non_writable_dir(self):
        """Processor exits 74 on non-writable directory without swallowing error."""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.chmod(tmpdir, 0o500)
            target_log = os.path.join(tmpdir, "inaccessible.log")
            diag_py = os.path.join(SCRIPT_DIR, "e2e_diagnostics.py")
            p = subprocess.Popen(
                [sys.executable, diag_py, "sink", "--log-file", target_log],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            _, stderr = p.communicate(input="diagnostic stream\n")
            os.chmod(tmpdir, 0o700)
            self.assertEqual(p.returncode, 74, f"Expected 74, got {p.returncode}")
            self.assertIn("Diagnostic log I/O failure", stderr)
            self.assertFalse(os.path.exists(target_log))

    def test_preserves_existing_snapshot_on_replace_failure(self):
        """When update fails, existing committed snapshot is preserved untouched."""
        with tempfile.TemporaryDirectory() as tmpdir:
            target_log = os.path.join(tmpdir, "existing.log")
            with open(target_log, "wb") as f:
                f.write(b"prior valid snapshot\n")

            os.chmod(tmpdir, 0o500)
            diag_py = os.path.join(SCRIPT_DIR, "e2e_diagnostics.py")
            p = subprocess.Popen(
                [sys.executable, diag_py, "sink", "--log-file", target_log],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            p.communicate(input="new uncommittable content\n")
            os.chmod(tmpdir, 0o700)
            self.assertEqual(p.returncode, 74)
            with open(target_log, "rb") as f:
                content = f.read()
            self.assertEqual(content, b"prior valid snapshot\n")

    def test_safe_stderr_recovery_fallback(self):
        """On recovery write failure, bounded summary is emitted to stderr with status 74."""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.chmod(tmpdir, 0o500)
            target_log = os.path.join(tmpdir, "fail_rec.log")
            diag_py = os.path.join(SCRIPT_DIR, "e2e_diagnostics.py")
            p = subprocess.Popen(
                [
                    sys.executable, diag_py, "append-recovery",
                    "--log-file", target_log,
                    "--exit-status", "47",
                    "--trap-signal", "0",
                    "--cleanup-failed", "0",
                    "--project", "test-project",
                    "--cid", "test_cid_12345",
                    "--workspace", "/tmp/ws_test"
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            _, stderr = p.communicate()
            os.chmod(tmpdir, 0o700)
            self.assertEqual(p.returncode, 74)
            self.assertIn("--- E2E Runtime Failure Recovery Information ---", stderr)
            self.assertIn("Exit status: 47", stderr)
            self.assertIn("test_cid_12345", stderr)


class TestAdversarialPerformance(unittest.TestCase):
    """Benchmarks and resource usage on reference host."""

    def test_200k_adversarial_newline_free(self):
        san = e2e_diagnostics.ByteStreamSanitizer()
        raw = b"data_" + (b"A" * 200000) + b"\n"
        t0 = time.time()
        res = san.feed(raw) + san.finish()
        elapsed = time.time() - t0
        self.assertLess(elapsed, 2.0, f"200k elapsed time {elapsed:.3f}s exceeded 2.0s limit")
        self.assertEqual(len(res), len(raw))

    def test_8mib_input_time_and_memory(self):
        san = e2e_diagnostics.ByteStreamSanitizer()
        chunk = b"Log message without trigger sequence\n" * 250  # ~9.25 KB
        total_bytes = 0
        target = 8 * 1024 * 1024
        t0 = time.time()
        while total_bytes < target:
            san.feed(chunk)
            total_bytes += len(chunk)
        san.finish()
        elapsed = time.time() - t0
        self.assertLess(elapsed, 10.0, f"8 MiB elapsed time {elapsed:.3f}s exceeded 10.0s limit")

    def test_32mib_input_time_and_memory(self):
        san = e2e_diagnostics.ByteStreamSanitizer()
        chunk = b"Typical application log chunk line\n" * 500  # ~17.5 KB
        total_bytes = 0
        target = 32 * 1024 * 1024
        t0 = time.time()
        while total_bytes < target:
            san.feed(chunk)
            total_bytes += len(chunk)
        san.finish()
        elapsed = time.time() - t0
        self.assertLess(elapsed, 30.0, f"32 MiB elapsed time {elapsed:.3f}s exceeded 30.0s limit")


class TestPipelinePrecedence(unittest.TestCase):
    """Verifies the producer-first status precedence and consumer draining."""

    def run_pipeline(self, producer_cmd: str, sanitizer_args: list, env_extra=None, cleanup_failed: int = 0):
        diag_py = os.path.join(SCRIPT_DIR, "e2e_diagnostics.py")
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)

        shell_script = f"""
        set +e
        {producer_cmd} | python3 "{diag_py}" {" ".join(sanitizer_args)}
        pipe_status=("${{PIPESTATUS[@]}}")
        cmd_exit="${{pipe_status[0]:-0}}"
        sanitizer_exit="${{pipe_status[1]:-0}}"
        cleanup_failed={cleanup_failed}

        if [ "$cmd_exit" -ne 0 ]; then
            exec_exit="$cmd_exit"
        elif [ "$sanitizer_exit" -ne 0 ]; then
            exec_exit="$sanitizer_exit"
        elif [ "$cleanup_failed" -ne 0 ]; then
            exec_exit=1
        else
            exec_exit=0
        fi
        exit "$exec_exit"
        """
        p = subprocess.Popen(
            ["bash", "-c", shell_script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True
        )
        stdout, stderr = p.communicate()
        return p.returncode, stdout, stderr

    def test_precedence_p47_s0_c0(self):
        code, _, _ = self.run_pipeline("bash -c 'exit 47'", ["filter"])
        self.assertEqual(code, 47)

    def test_precedence_p47_s74_c0(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.chmod(tmpdir, 0o500)
            target_log = os.path.join(tmpdir, "inaccessible.log")
            code, _, _ = self.run_pipeline(
                "bash -c 'echo canary; exit 47'",
                ["sink", "--log-file", target_log]
            )
            os.chmod(tmpdir, 0o700)
            self.assertEqual(code, 47, "Producer exit 47 must take precedence over S74")

    def test_precedence_p0_s74_c0(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.chmod(tmpdir, 0o500)
            target_log = os.path.join(tmpdir, "inaccessible.log")
            code, _, _ = self.run_pipeline(
                "bash -c 'echo normal; exit 0'",
                ["sink", "--log-file", target_log]
            )
            os.chmod(tmpdir, 0o700)
            self.assertEqual(code, 74, "Diagnostic I/O failure 74 must be returned when P=0")

    def test_precedence_p0_s0_c1(self):
        code, _, _ = self.run_pipeline("bash -c 'echo normal; exit 0'", ["filter"], cleanup_failed=1)
        self.assertEqual(code, 1, "Cleanup failure must be returned when P=0, S=0")

    def test_precedence_p0_s74_c1(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.chmod(tmpdir, 0o500)
            target_log = os.path.join(tmpdir, "inaccessible.log")
            code, _, _ = self.run_pipeline(
                "bash -c 'echo normal; exit 0'",
                ["sink", "--log-file", target_log],
                cleanup_failed=1
            )
            os.chmod(tmpdir, 0o700)
            self.assertEqual(code, 74, "Diagnostic failure 74 must take precedence over cleanup 1")

    def test_consumer_guard_prevents_producer_sigpipe(self):
        """Producer generating continuous data does not exit 141 (SIGPIPE) when consumer fails I/O."""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.chmod(tmpdir, 0o500)
            target_log = os.path.join(tmpdir, "inaccessible.log")
            diag_py = os.path.join(SCRIPT_DIR, "e2e_diagnostics.py")
            producer_script = "for i in $(seq 1 50); do echo \"chunk $i\"; sleep 0.01; done; exit 47"
            shell_script = f"""
            set +e
            bash -c '{producer_script}' | python3 "{diag_py}" sink --log-file "{target_log}"
            pipe_status=("${{PIPESTATUS[@]}}")
            cmd_exit="${{pipe_status[0]:-0}}"
            sanitizer_exit="${{pipe_status[1]:-0}}"
            echo "CMD:$cmd_exit SAN:$sanitizer_exit"
            """
            p = subprocess.Popen(
                ["bash", "-c", shell_script],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            stdout, _ = p.communicate()
            os.chmod(tmpdir, 0o700)
            self.assertIn("CMD:47", stdout, "Producer should exit 47, not 141 SIGPIPE")
            self.assertIn("SAN:74", stdout, "Sanitizer should exit 74")


if __name__ == "__main__":
    unittest.main()
