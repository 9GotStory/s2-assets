#!/usr/bin/env python3
"""Deterministic standard-library-only byte-stream sanitizer and bounded diagnostic writer

for T046 [US4] Isolated Playwright Runtime Preflight.

Supports streaming filter, sink, tee, file sanitization, and recovery metadata recording
with strict partition invariance, fail-closed I/O, bounded memory, and explicit error status codes.
"""

from collections import deque
import os
import re
import signal
import sys

# Standard diagnostic exit codes
EXIT_SUCCESS = 0
EXIT_INTERNAL_ERROR = 70
EXIT_IO_ERROR = 74

# Bounded ring buffer limits
MAX_LOG_BYTES = 51200
MAX_LOG_LINES = 1000
MAX_CONSOLE_BYTES = 51200
RECOVERY_RESERVED_BYTES = 4096
RECOVERY_RESERVED_LINES = 32
CHUNK_SIZE = 16384

# Lexical definitions
ASCII_WHITESPACE = b" \t\r\n\v\f"
ASCII_WHITESPACE_SET = set(ASCII_WHITESPACE)

TRIGGER_FIRST_BYTES = set(b":PpCcDdSsTtKkBb")

ALL_TRIGGER_PREFIXES = set()
ALL_TRIGGER_PREFIXES.add(b":")
ALL_TRIGGER_PREFIXES.add(b":/")

KEYS = [
    b"POSTGRES_PASSWORD=",
    b"COOKIE_SECRET=",
    b"DATABASE_URL=",
    b"PASSWORD=",
    b"SECRET=",
    b"TOKEN=",
    b"KEY=",
]

for k in KEYS:
  for i in range(1, len(k)):
    ALL_TRIGGER_PREFIXES.add(k[:i])

for i in range(1, 7):
  ALL_TRIGGER_PREFIXES.add(b"BEARER"[:i])

KEYS_SET = set(KEYS)

TRIGGER_RE = re.compile(
    rb"(?i)(?P<url>:\/\/)|(?P<key>POSTGRES_PASSWORD=|COOKIE_SECRET=|DATABASE_URL=|PASSWORD=|SECRET=|TOKEN=|KEY=)|(?P<bearer>BEARER[ \t\r\n\v\f])"
)


class ByteStreamSanitizer:
  """Deterministic, bounded-memory byte-stream sanitizer.

  Maintains strict partition invariance across arbitrary read boundaries.
  Never publishes undecided sensitive bytes due to length, chunk boundaries, or EOF.
  """

  def __init__(self):
    self.state = "TEXT"
    self.pending = b""
    self.quote_char = b""
    self.escaped = False

  def reset(self):
    self.state = "TEXT"
    self.pending = b""
    self.quote_char = b""
    self.escaped = False

  def feed(self, chunk: bytes) -> bytes:
    if not chunk:
      return b""
    buf = self.pending + chunk
    self.pending = b""
    emitted = bytearray()

    while buf:
      if self.state == "TEXT":
        m = TRIGGER_RE.search(buf)
        if not m:
          max_k = min(len(buf), 18)
          split_idx = len(buf)
          for k in range(max_k, 0, -1):
            cand = buf[-k:]
            if cand.upper() in ALL_TRIGGER_PREFIXES or cand in (b":", b":/"):
              split_idx = len(buf) - k
              break
          emitted.extend(buf[:split_idx])
          self.pending = buf[split_idx:]
          buf = b""
        else:
          emitted.extend(buf[:m.start()])
          if m.group("url"):
            emitted.extend(b"://[REDACTED_URL]")
            self.state = "URL_DROP"
            buf = buf[m.end():]
          elif m.group("key"):
            emitted.extend(buf[m.start():m.end()])
            self.state = "VALUE_WAIT"
            buf = buf[m.end():]
          elif m.group("bearer"):
            emitted.extend(buf[m.start():m.end()])
            self.state = "BEARER_WAIT"
            buf = buf[m.end():]

      elif self.state == "URL_DROP":
        m = re.search(rb"[\s]", buf)
        if m:
          self.state = "TEXT"
          emitted.extend(m.group(0))
          buf = buf[m.end():]
        else:
          buf = b""

      elif self.state == "VALUE_WAIT":
        m = re.search(rb"[^\s]", buf)
        if m:
          emitted.extend(buf[:m.start()])
          ch = buf[m.start():m.start() + 1]
          if ch in (b"\"", b"'"):
            self.state = "QUOTED_DROP"
            self.quote_char = ch
            self.escaped = False
            emitted.extend(ch + b"[REDACTED]")
            buf = buf[m.start() + 1:]
          else:
            self.state = "VALUE_DROP"
            emitted.extend(b"[REDACTED]")
            buf = buf[m.start() + 1:]
        else:
          emitted.extend(buf)
          buf = b""

      elif self.state == "VALUE_DROP":
        m = re.search(rb"[\s]", buf)
        if m:
          self.state = "TEXT"
          emitted.extend(m.group(0))
          buf = buf[m.end():]
        else:
          buf = b""

      elif self.state == "BEARER_WAIT":
        m = re.search(rb"[^\s]", buf)
        if m:
          emitted.extend(buf[:m.start()])
          ch = buf[m.start():m.start() + 1]
          if ch in (b"\"", b"'"):
            self.state = "QUOTED_DROP"
            self.quote_char = ch
            self.escaped = False
            emitted.extend(ch + b"[REDACTED]")
            buf = buf[m.start() + 1:]
          else:
            self.state = "BEARER_DROP"
            emitted.extend(b"[REDACTED]")
            buf = buf[m.start() + 1:]
        else:
          emitted.extend(buf)
          buf = b""

      elif self.state == "BEARER_DROP":
        m = re.search(rb"[\s]", buf)
        if m:
          self.state = "TEXT"
          emitted.extend(m.group(0))
          buf = buf[m.end():]
        else:
          buf = b""

      elif self.state == "QUOTED_DROP":
        q_re = re.compile(
            rb"(\\.|" + re.escape(self.quote_char) + rb")", re.DOTALL
        )
        m = q_re.search(buf)
        if m:
          matched = m.group(1)
          if matched.startswith(b"\\"):
            buf = buf[m.end():]
          else:
            self.state = "TEXT"
            emitted.extend(matched)
            self.quote_char = b""
            buf = buf[m.end():]
        else:
          if buf.endswith(b"\\") and not buf.endswith(b"\\\\"):
            self.pending = b"\\"
            buf = b""
          else:
            buf = b""

      elif self.state == "FAILED_DRAIN":
        buf = b""

    return bytes(emitted)

  def finish(self) -> bytes:
    out = bytearray()
    if self.state in ("VALUE_WAIT", "BEARER_WAIT"):
      out.extend(b"[REDACTED]")
      self.state = "TEXT"
    elif self.state == "QUOTED_DROP":
      self.state = "TEXT"
    elif self.state in ("VALUE_DROP", "BEARER_DROP", "URL_DROP"):
      self.state = "TEXT"
    elif self.state == "TEXT":
      if self.pending:
        if self.pending.upper() in ALL_TRIGGER_PREFIXES or self.pending in (b":", b":/"):
          out.extend(b"[REDACTED]")
        else:
          out.extend(self.pending)
        self.pending = b""
    return bytes(out)


class BoundedRingBuffer:
  """Byte-counted rolling ring buffer enforcing both byte and line limits."""

  def __init__(
      self, max_bytes: int = MAX_LOG_BYTES, max_lines: int = MAX_LOG_LINES
  ):
    self.max_bytes = max_bytes
    self.max_lines = max_lines
    self.buffer = deque()
    self.current_bytes = 0

  def append(self, data: bytes):
    if not data:
      return
    lines = data.splitlines(keepends=True)
    if not lines:
      return

    first_line_idx = 0
    if self.buffer and not self.buffer[-1].endswith(b"\n"):
      combined = self.buffer[-1] + lines[0]
      self.current_bytes -= len(self.buffer[-1])
      self.buffer[-1] = combined
      self.current_bytes += len(combined)
      first_line_idx = 1

    for line in lines[first_line_idx:]:
      self.buffer.append(line)
      self.current_bytes += len(line)

    self._enforce_bounds()

  def _enforce_bounds(self):
    while self.current_bytes > self.max_bytes:
      excess = self.current_bytes - self.max_bytes
      oldest = self.buffer[0]
      if len(oldest) <= excess:
        self.buffer.popleft()
        self.current_bytes -= len(oldest)
      else:
        rem = oldest[excess:]
        self.buffer[0] = rem
        self.current_bytes -= excess
        break

    while len(self.buffer) > self.max_lines:
      popped = self.buffer.popleft()
      self.current_bytes -= len(popped)

  def get_bytes(self) -> bytes:
    return b"".join(self.buffer)

  def write_to_disk_atomic(self, target_path: str):
    """Writes the buffer atomically to target_path using fsync and replace.

    Raises OSError / PermissionError on failure.
    """
    if not target_path:
      return

    target_abs = os.path.abspath(target_path)
    target_dir = os.path.dirname(target_abs)
    if not os.path.exists(target_dir):
      os.makedirs(target_dir, mode=0o700, exist_ok=True)

    tmp_path = os.path.join(
        target_dir, f".{os.path.basename(target_abs)}.tmp.{os.getpid()}"
    )

    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if hasattr(os, "O_NOFOLLOW"):
      flags |= os.O_NOFOLLOW

    try:
      fd = os.open(tmp_path, flags, 0o600)
      try:
        data = self.get_bytes()
        total_written = 0
        while total_written < len(data):
          written = os.write(fd, data[total_written:])
          if written == 0:
            raise OSError("Short write while committing diagnostic snapshot")
          total_written += written
        os.fsync(fd)
      finally:
        os.close(fd)

      os.replace(tmp_path, target_abs)

      # Attempt directory fsync on POSIX systems
      try:
        dir_fd = os.open(target_dir, os.O_RDONLY)
        try:
          os.fsync(dir_fd)
        finally:
          os.close(dir_fd)
      except Exception:
        pass
    finally:
      if os.path.exists(tmp_path):
        try:
          os.remove(tmp_path)
        except OSError:
          pass


def drain_stdin():
  """Consumes remaining stdin to prevent SIGPIPE on producer."""
  try:
    while True:
      chunk = sys.stdin.buffer.read(CHUNK_SIZE)
      if not chunk:
        break
  except Exception:
    pass


def process_stream(mode: str, log_path: str = "") -> int:
  """Processes stdin in mode: filter, sink, or tee."""
  if os.environ.get("FOUNDATION_E2E_SIMULATE_SANITIZER_FAIL") == "1":
    drain_stdin()
    sys.stderr.write(
        "ERROR: Simulated diagnostic stream processor failure (exit code 1)\n"
    )
    return 1

  san = ByteStreamSanitizer()
  ring_buf = BoundedRingBuffer(
      max_bytes=MAX_LOG_BYTES - RECOVERY_RESERVED_BYTES,
      max_lines=MAX_LOG_LINES - RECOVERY_RESERVED_LINES,
  )

  do_tee = mode == "tee"
  is_filter = mode == "filter"

  # Initial sink validation upfront before reading stream
  if log_path and not is_filter:
    try:
      if os.path.exists(log_path):
        with open(log_path, "rb") as f:
          ring_buf.append(f.read())
      ring_buf.write_to_disk_atomic(log_path)
    except Exception as e:
      drain_stdin()
      errno = getattr(e, "errno", 0)
      sys.stderr.write(
          f"ERROR: Diagnostic log I/O failure (errno {errno}): unable to"
          f" initialize sink at {log_path}\n"
      )
      return EXIT_IO_ERROR

  console_bytes = 0
  console_truncated = False
  unflushed_count = 0

  def handle_sig(sig, frame):
    if log_path and not is_filter:
      try:
        ring_buf.write_to_disk_atomic(log_path)
      except Exception:
        pass
    sys.exit(128 + sig)

  signal.signal(signal.SIGINT, handle_sig)
  signal.signal(signal.SIGTERM, handle_sig)

  try:
    while True:
      chunk = sys.stdin.buffer.read(CHUNK_SIZE)
      if not chunk:
        break

      s_chunk = san.feed(chunk)
      if not s_chunk:
        continue

      if do_tee or is_filter:
        b_len = len(s_chunk)
        if console_bytes + b_len <= MAX_CONSOLE_BYTES:
          sys.stdout.buffer.write(s_chunk)
          sys.stdout.buffer.flush()
          console_bytes += b_len
        elif not console_truncated:
          notice = (
              b"\n[Console output truncated after 51200 bytes; remaining"
              b" diagnostic stream drained to bounded log]\n"
          )
          avail = MAX_CONSOLE_BYTES - console_bytes
          if avail > len(notice):
            sys.stdout.buffer.write(s_chunk[: avail - len(notice)])
            sys.stdout.buffer.write(notice)
            console_bytes += avail
          else:
            sys.stdout.buffer.write(notice)
            console_bytes += len(notice)
          sys.stdout.buffer.flush()
          console_truncated = True

      if not is_filter:
        ring_buf.append(s_chunk)
        unflushed_count += 1
        if unflushed_count >= 10:
          try:
            ring_buf.write_to_disk_atomic(log_path)
            unflushed_count = 0
          except Exception as e:
            san.state = "FAILED_DRAIN"
            drain_stdin()
            errno = getattr(e, "errno", 0)
            sys.stderr.write(
                f"ERROR: Diagnostic log I/O failure (errno {errno}): unable to"
                f" write snapshot to {log_path}\n"
            )
            return EXIT_IO_ERROR

    s_tail = san.finish()
    if s_tail:
      if do_tee or is_filter:
        if console_bytes + len(s_tail) <= MAX_CONSOLE_BYTES:
          sys.stdout.buffer.write(s_tail)
          sys.stdout.buffer.flush()
          console_bytes += len(s_tail)
      if not is_filter:
        ring_buf.append(s_tail)

    if log_path and not is_filter:
      try:
        ring_buf.write_to_disk_atomic(log_path)
      except Exception as e:
        errno = getattr(e, "errno", 0)
        sys.stderr.write(
            f"ERROR: Diagnostic log I/O failure (errno {errno}): unable to"
            f" finalize snapshot at {log_path}\n"
        )
        return EXIT_IO_ERROR

    return EXIT_SUCCESS

  except Exception as e:
    san.state = "FAILED_DRAIN"
    drain_stdin()
    sys.stderr.write(f"ERROR: Diagnostic processor invariant failure: {e}\n")
    return EXIT_INTERNAL_ERROR


def sanitize_file(input_path: str, output_path: str = "") -> int:
  """Reads input_path, sanitizes, bounds, and replaces output_path."""
  if not output_path:
    output_path = input_path
  if not os.path.exists(input_path):
    return EXIT_SUCCESS

  try:
    with open(input_path, "rb") as f:
      raw = f.read()
  except Exception as e:
    errno = getattr(e, "errno", 0)
    sys.stderr.write(
        f"ERROR: Diagnostic file read failure (errno {errno}) for"
        f" {input_path}\n"
    )
    return EXIT_IO_ERROR

  san = ByteStreamSanitizer()
  s_data = san.feed(raw) + san.finish()

  ring_buf = BoundedRingBuffer(
      max_bytes=MAX_LOG_BYTES, max_lines=MAX_LOG_LINES
  )
  ring_buf.append(s_data)

  try:
    ring_buf.write_to_disk_atomic(output_path)
    return EXIT_SUCCESS
  except Exception as e:
    errno = getattr(e, "errno", 0)
    sys.stderr.write(
        f"ERROR: Diagnostic log I/O failure (errno {errno}): unable to"
        f" sanitize file {output_path}\n"
    )
    return EXIT_IO_ERROR


def append_stream(log_path: str) -> int:
  """Reads stdin, sanitizes, and appends to bounded log file atomically."""
  if not log_path:
    return EXIT_SUCCESS

  ring_buf = BoundedRingBuffer(
      max_bytes=MAX_LOG_BYTES, max_lines=MAX_LOG_LINES
  )
  if os.path.exists(log_path):
    try:
      with open(log_path, "rb") as f:
        ring_buf.append(f.read())
    except Exception as e:
      errno = getattr(e, "errno", 0)
      sys.stderr.write(
          f"ERROR: Diagnostic file read failure (errno {errno}) for {log_path}\n"
      )
      return EXIT_IO_ERROR

  san = ByteStreamSanitizer()
  try:
    while True:
      chunk = sys.stdin.buffer.read(CHUNK_SIZE)
      if not chunk:
        break
      s_chunk = san.feed(chunk)
      if s_chunk:
        ring_buf.append(s_chunk)
    s_tail = san.finish()
    if s_tail:
      ring_buf.append(s_tail)

    ring_buf.write_to_disk_atomic(log_path)
    return EXIT_SUCCESS
  except Exception as e:
    drain_stdin()
    errno = getattr(e, "errno", 0)
    sys.stderr.write(
        f"ERROR: Diagnostic log I/O failure (errno {errno}): unable to append"
        f" to {log_path}\n"
    )
    return EXIT_IO_ERROR


def append_recovery_metadata(
    log_path: str,
    exit_status: int,
    trap_signal: int,
    cleanup_failed: int,
    project: str,
    cid: str = "",
    workspace: str = "",
) -> int:
  """Appends structured non-secret recovery block to log or stderr on I/O failure."""
  lines = [
      b"\n--- E2E Runtime Failure Recovery Information ---\n",
      f"Exit status: {exit_status}\n".encode("utf-8"),
      f"Trap signal: {trap_signal}\n".encode("utf-8"),
      f"Cleanup failed: {cleanup_failed}\n".encode("utf-8"),
      f"Project: {project}\n".encode("utf-8"),
  ]
  if cid:
    lines.append(f"Unremoved runner container ID: {cid}\n".encode("utf-8"))
    lines.append(
        f"Manual container removal command: podman rm -f -t 1 {cid}\n".encode(
            "utf-8"
        )
    )
  if workspace:
    lines.append(f"Unremoved runner workspace: {workspace}\n".encode("utf-8"))
    lines.append(
        f"Manual workspace removal command: rm -rf {workspace}\n".encode(
            "utf-8"
        )
    )
  lines.append(
      f"Recovery: Ensure web container is healthy in project '{project}',"
      " check connectivity to http://web:5173, then rerun 'bash scripts/dev.sh"
      " e2e --preflight'\n".encode("utf-8")
  )
  lines.append(b"------------------------------------------------\n")
  recovery_block = b"".join(lines)

  ring_buf = BoundedRingBuffer(
      max_bytes=MAX_LOG_BYTES, max_lines=MAX_LOG_LINES
  )
  if log_path and os.path.exists(log_path):
    try:
      with open(log_path, "rb") as f:
        ring_buf.append(f.read())
    except Exception:
      pass

  ring_buf.append(recovery_block)

  try:
    if log_path:
      ring_buf.write_to_disk_atomic(log_path)
      return EXIT_SUCCESS
  except Exception as e:
    errno = getattr(e, "errno", 0)
    sys.stderr.write(
        f"ERROR: Diagnostic log I/O failure (errno {errno}): unable to write"
        f" recovery metadata to {log_path}\n"
    )

  # Fallback to stderr when log write fails or log_path not provided
  try:
    sys.stderr.buffer.write(recovery_block)
    sys.stderr.buffer.flush()
  except Exception:
    pass

  return EXIT_IO_ERROR if log_path else EXIT_SUCCESS


def main():
  import argparse

  parser = argparse.ArgumentParser(
      description="T046 E2E Diagnostics Sanitizer and Writer"
  )
  subparsers = parser.add_subparsers(dest="command")

  # filter
  subparsers.add_parser("filter", help="Stream filter from stdin to stdout")

  # sink
  sink_p = subparsers.add_parser(
      "sink", help="Stream sink from stdin to bounded log file"
  )
  sink_p.add_argument(
      "--log-file", required=True, help="Destination log file path"
  )

  # tee
  tee_p = subparsers.add_parser(
      "tee", help="Stream tee from stdin to stdout and bounded log file"
  )
  tee_p.add_argument(
      "--log-file", required=True, help="Destination log file path"
  )

  # sanitize-file
  sf_p = subparsers.add_parser(
      "sanitize-file", help="Sanitize existing file in-place"
  )
  sf_p.add_argument("input_file", help="File to sanitize")
  sf_p.add_argument(
      "output_file",
      nargs="?",
      default="",
      help="Output file (defaults to input_file)",
  )

  # append
  app_p = subparsers.add_parser(
      "append", help="Append stream from stdin to bounded log"
  )
  app_p.add_argument(
      "--log-file", required=True, help="Destination log file path"
  )

  # append-recovery
  rec_p = subparsers.add_parser(
      "append-recovery", help="Append structured recovery block"
  )
  rec_p.add_argument(
      "--log-file", required=True, help="Destination log file path"
  )
  rec_p.add_argument(
      "--exit-status", type=int, default=0, help="Process exit status"
  )
  rec_p.add_argument(
      "--trap-signal", type=int, default=0, help="Trap signal code"
  )
  rec_p.add_argument(
      "--cleanup-failed", type=int, default=0, help="Cleanup failed indicator"
  )
  rec_p.add_argument(
      "--project", required=True, help="Compose project name"
  )
  rec_p.add_argument("--cid", default="", help="Container ID handle")
  rec_p.add_argument(
      "--workspace", default="", help="Runner workspace directory path"
  )

  args = parser.parse_args()

  if args.command == "filter":
    sys.exit(process_stream("filter"))
  elif args.command == "sink":
    sys.exit(process_stream("sink", args.log_file))
  elif args.command == "tee":
    sys.exit(process_stream("tee", args.log_file))
  elif args.command == "sanitize-file":
    sys.exit(sanitize_file(args.input_file, args.output_file))
  elif args.command == "append":
    sys.exit(append_stream(args.log_file))
  elif args.command == "append-recovery":
    sys.exit(
        append_recovery_metadata(
            args.log_file,
            args.exit_status,
            args.trap_signal,
            args.cleanup_failed,
            args.project,
            args.cid,
            args.workspace,
        )
    )
  else:
    parser.print_help()
    sys.exit(EXIT_INTERNAL_ERROR)


if __name__ == "__main__":
  main()
