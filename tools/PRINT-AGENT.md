# The station print agent moved

`tools/print_agent.py` used to live here. It is now one of two protocol drivers in a **single
agent that serves KP Front and KP Rück both**:

> **https://github.com/feuerwehr-oberwil/kp-rueck/tree/main/tools/print-agent**

A station running both systems was otherwise running two agents on one box — two services, two
secrets, two install methods, two log streams — to talk to the same printer room.

## What did *not* change

**KP Front's wire contract is still KP Front's.** The agent was ported to it; the backend was
not changed to suit the agent:

| | |
| --- | --- |
| `POST /api/print-agent/claim` | long-poll, ~25 s hang, near-instant claim |
| `GET /api/print-agent/jobs/{id}/file` | the composed PDF |
| `POST /api/print-agent/jobs/{id}/status` | `done` / `failed` |
| Auth | `X-Print-Agent-Secret`, matched against `PRINT_AGENT_SECRET` |

Those endpoints are documented in [`docs/CONFIGURATION.md`](../docs/CONFIGURATION.md) and stay
part of this repository. Writing your own agent against them is still entirely reasonable — the
contract is the interface, the agent is just the reference implementation.

Behaviour that was deliberately preserved in the port: a CUPS job that is still queued counts
as **pending, not failed** (CUPS stores and forwards, so it prints once the printer comes back),
`lp` options are appended after the A4/duplex/monochrome defaults so a station can override any
of them, and a rejected secret stops the worker rather than retrying forever.

## Migrating an existing Pi

The old single-file install (`/usr/local/bin/kp-print-agent`, unit
`kp-front-print-agent.service`) keeps working — nothing was removed from the backend. When you
do migrate:

```bash
sudo systemctl disable --now kp-front-print-agent    # FIRST — see the warning below
sudo mkdir -p /opt/kp-print-agent
sudo cp -r <kp-rueck>/tools/print-agent/* /opt/kp-print-agent/
python3 /opt/kp-print-agent/agent.py install         # prints the unit and setup steps
```

Your existing environment variables (`KP_BASE_URL`, `KP_PRINT_AGENT_SECRET`, `KP_PRINTER`,
`KP_LP_OPTS`, `KP_POLL_SEC`, `KP_CLAIM_TIMEOUT_SEC`, `KP_CUPS_TIMEOUT_SEC`) are read unchanged,
so a KP-Front-only station needs no config file at all. Add one only to serve both systems.

> ⚠️ **Stop the old agent before starting the new one.** Two agents polling the same queue both
> claim jobs, and each job prints once — from whichever asked first. The symptom is prints that
> "sometimes don't arrive" while both logs look healthy.

The CUPS path needs **no Python packages** — the agent's core is stdlib-only precisely so the
bare-Pi install keeps working.
