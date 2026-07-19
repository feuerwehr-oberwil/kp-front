#!/usr/bin/env python3
"""KP Front station print agent — polls the backend print queue and prints via CUPS.

Runs on any always-on box on the station LAN (a Raspberry Pi is plenty) that has a CUPS
queue for the station printer. Pull-based: the agent makes outbound HTTPS requests only —
no inbound ports, no exposure of CUPS, no coupling of the backend to the LAN. Stdlib only;
Python ≥ 3.9.

Loop: claim the oldest queued job (`POST /api/print-agent/claim`, authenticated with
`X-Print-Agent-Secret`) → download the composed PDF → `lp -d $KP_PRINTER` → watch
`lpstat -W not-completed` until the CUPS job drains → report done. Claiming with an empty
queue is the heartbeat that shows the relay «online» in the app.

A CUPS job that stays queued (printer off, paper out, network hiccup) is PENDING, not
failed: CUPS stores and forwards, so the agent waits up to KP_CUPS_TIMEOUT_SEC and only
then reports the job failed — noting that it may still print once the printer recovers —
and moves on.

Environment (see `python3 print_agent.py install` for setup):
  KP_BASE_URL             backend origin, e.g. https://front.example.org (required)
  KP_PRINT_AGENT_SECRET   must match the backend's PRINT_AGENT_SECRET (required)
  KP_PRINTER              CUPS destination, e.g. from `lpstat -p` (required)
  KP_POLL_SEC             claim interval in seconds (default 5)
  KP_LP_OPTS              extra `lp` options, space-separated, appended after the
                          defaults (A4, duplex, monochrome-unless-Kroki) — CUPS takes
                          the last occurrence of a same-name option, so this overrides
                          any default for printers that need it
  KP_CUPS_TIMEOUT_SEC     how long a job may sit in CUPS before it counts as failed
                          (default 1800)

Subcommands:
  (none)    run the poll loop (what systemd runs)
  once      one claim cycle, then exit — for smoke-testing the wiring
  install   print the systemd unit, env-file template, and install steps
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# Under systemd there is often no locale → Python's stdout falls back to latin-1 and any
# non-latin-1 character in a log line would crash the loop. Force UTF-8, never crash on log.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

POLL_SEC = float(os.environ.get("KP_POLL_SEC", "5"))
CUPS_TIMEOUT_SEC = float(os.environ.get("KP_CUPS_TIMEOUT_SEC", "1800"))
# Defaults: A4, duplex, and monochrome unless the job carries the coloured Kroki.
# KP_LP_OPTS appends extra `lp` options AFTER these — for a same-name option CUPS takes
# the last occurrence, so the env can override any default (printers differ).
BASE_LP_OPTS = ["-o", "media=A4", "-o", "sides=two-sided-long-edge"]
MONO_LP_OPTS = ["-o", "print-color-mode=monochrome"]
LP_OPTS = (os.environ.get("KP_LP_OPTS") or "").split()
BACKOFF_MAX_SEC = 60.0

_REQUEST_ID = re.compile(r"request id is (\S+)")


def log(msg: str) -> None:
    print(msg, flush=True)  # journald adds the timestamp


def _env(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        log(f"FATAL: {name} ist nicht gesetzt — siehe `python3 print_agent.py install`")
        sys.exit(2)
    return v


def _request(base: str, secret: str, path: str, body: bytes | None = None,
             timeout: float = 30.0) -> tuple[int, bytes]:
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=body,
        method="POST" if body is not None else ("POST" if path.endswith("/claim") else "GET"),
        headers={"X-Print-Agent-Secret": secret, **({"Content-Type": "application/json"} if body else {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def claim(base: str, secret: str) -> dict | None:
    status, data = _request(base, secret, "/api/print-agent/claim", body=b"")
    if status == 204:
        return None
    if status == 200:
        return json.loads(data)
    if status in (401, 403):
        log(f"FATAL: Backend lehnt das Agent-Secret ab (HTTP {status}) — KP_PRINT_AGENT_SECRET prüfen")
        sys.exit(2)
    raise RuntimeError(f"claim: HTTP {status}")


def report(base: str, secret: str, job_id: str, status: str, error: str | None = None) -> None:
    body = json.dumps({"status": status, "error": error}).encode()
    code, _ = _request(base, secret, f"/api/print-agent/jobs/{job_id}/status", body=body)
    if code != 200:
        log(f"WARN: Statusmeldung für {job_id} → HTTP {code}")


def cups_pending(printer: str, request_id: str) -> bool:
    out = subprocess.run(
        ["lpstat", "-W", "not-completed", "-o", printer],
        capture_output=True, text=True, timeout=30,
    ).stdout
    return any(line.split()[:1] == [request_id] for line in out.splitlines() if line.strip())


def print_job(base: str, secret: str, printer: str, job: dict) -> None:
    job_id = job["id"]
    status, pdf = _request(base, secret, f"/api/print-agent/jobs/{job_id}/file", timeout=120.0)
    if status != 200:
        report(base, secret, job_id, "failed", f"PDF-Download: HTTP {status}")
        return

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(pdf)
        tmp = fh.name
    try:
        opts = BASE_LP_OPTS + ([] if job.get("color") else MONO_LP_OPTS) + LP_OPTS
        cmd = ["lp", "-d", printer, "-t", job.get("filename") or job_id, *opts, tmp]
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if run.returncode != 0:
            report(base, secret, job_id, "failed", f"lp: {run.stderr.strip()[:500]}")
            return
        m = _REQUEST_ID.search(run.stdout)
        request_id = m.group(1) if m else ""
        log(f"Auftrag {job_id} → CUPS {request_id or '?'} ({len(pdf)} Bytes)")

        # Wait for CUPS to drain the job. Still-queued is pending (store-and-forward),
        # not failed — only after the long timeout do we give up and move on.
        deadline = time.monotonic() + CUPS_TIMEOUT_SEC
        while request_id and cups_pending(printer, request_id):
            if time.monotonic() > deadline:
                report(base, secret, job_id, "failed",
                       f"CUPS-Auftrag {request_id} weiterhin in Warteschlange — "
                       "druckt evtl. nach Behebung der Störung")
                return
            time.sleep(5)
        report(base, secret, job_id, "done")
        log(f"Auftrag {job_id}: gedruckt")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def run_loop(once: bool = False) -> None:
    base = _env("KP_BASE_URL")
    secret = _env("KP_PRINT_AGENT_SECRET")
    printer = _env("KP_PRINTER")
    log(f"kp-print-agent: {base} → Drucker {printer} (Poll {POLL_SEC:.0f}s)")

    backoff = POLL_SEC
    while True:
        try:
            job = claim(base, secret)
            if job is not None:
                print_job(base, secret, printer, job)
            backoff = POLL_SEC
        except Exception as e:  # one bad cycle never kills the loop
            log(f"WARN: {e} — nächster Versuch in {backoff:.0f}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX_SEC)
            if once:
                sys.exit(1)
            continue
        if once:
            return
        time.sleep(POLL_SEC)


INSTALL = """\
# --- kp-print-agent install (Raspberry Pi / any Debian-ish box with CUPS) -------------
#
# 0) Prerequisites: a working CUPS queue for the station printer —
#      lpstat -p                      # list destinations
#      lp -d <PRINTER> test.pdf      # must produce paper
#    and the backend deployment must set PRINT_AGENT_SECRET (openssl rand -hex 24).
#
# 1) Copy this file (the unit name is deliberately kp-front-*: don't collide with other
#    print agents that may already live on the same box):
#      sudo install -m 0755 print_agent.py /usr/local/bin/kp-print-agent
#
# 2) Dedicated system user with printing rights:
#      sudo useradd -r -s /usr/sbin/nologin -G lp kpprint
#
# 3) Environment (secret is in here — root-only):
#      sudo install -m 0600 /dev/null /etc/kp-front-print-agent.env
#      sudo tee /etc/kp-front-print-agent.env >/dev/null <<'EOF'
KP_BASE_URL=https://front.example.org
KP_PRINT_AGENT_SECRET=<PRINT_AGENT_SECRET>
KP_PRINTER=<CUPS destination from lpstat -p>
KP_POLL_SEC=5
# extra lp options, appended after the defaults (A4, duplex, monochrome-unless-Kroki);
# same-name options override — e.g. simplex printers: KP_LP_OPTS=-o sides=one-sided
# KP_LP_OPTS=
# KP_CUPS_TIMEOUT_SEC=1800
EOF
#
# 4) systemd unit:
#      sudo tee /etc/systemd/system/kp-front-print-agent.service >/dev/null <<'EOF'
[Unit]
Description=KP Front station print agent
After=network-online.target cups.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/kp-front-print-agent.env
ExecStart=/usr/bin/python3 /usr/local/bin/kp-print-agent
Restart=always
RestartSec=10
User=kpprint
Group=lp

[Install]
WantedBy=multi-user.target
EOF
#
# 5) Enable + verify:
#      sudo systemctl daemon-reload
#      sudo systemctl enable --now kp-front-print-agent
#      journalctl -u kp-front-print-agent -f   # heartbeat log; the app now shows the relay online
#
# Smoke test without systemd:  KP_BASE_URL=… KP_PRINT_AGENT_SECRET=… KP_PRINTER=… \\
#      python3 print_agent.py once
"""


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "install":
        print(INSTALL)
    elif cmd == "once":
        run_loop(once=True)
    elif cmd == "":
        run_loop()
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
