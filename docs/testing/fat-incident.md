# Fat incident – does a large or long Einsatz make the app worse?

**Status:** measurement tooling + the first recorded run (2026-09-26)
**Audience:** whoever changes the save path, the Karte's rendering, the Verlauf or the Replay

A long or large Einsatz is exactly where the app matters most, and it is also where every
per-save, per-object and per-row cost adds up. This page covers the tooling that measures
this and what it found the first time it ran.

## When to run them

**Large / long incidents** (26.09.2026): `pnpm bench` times the pure hot paths and `just fat-perf
[preset …]` plays a synthetic fat incident (`src/lib/fatIncident.ts`) into a throwaway backend and
opens it on a CPU-throttled browser. Measurements, not gates. Run them when you change the save
path, the Karte's rendering, the Verlauf or the Replay, and compare against the recorded run in
[`docs/testing/fat-incident.md`](fat-incident.md).

## The fat incident

`src/lib/fatIncident.ts` builds a synthetic, deterministic incident. It is sized against the
real record rather than guessed. A read-only look at prod on 2026-09-26 found the busiest real
incidents to be:

- 5½ h long, 1 458 saves (one snapshot each) and 1 754 audit events
- at most 14 symbols on the Karte and 28 plan annotations
- about 25 people in the Anwesenheit and 233 Verlauf rows
- a biggest blob of 79 KB

It has two knobs because they grow different things:

- **`scale`** grows what is standing at once: symbols, lines, plan annotations, people and concurrent Trupps.
- **`hours`** grows what accumulates: Verlauf rows, Trupp readings and trails, Mittel, saves and audit events.

| Preset | scale × hours | Blob | Karte objects | Verlauf rows | Audit events | Saves |
| --- | --- | --- | --- | --- | --- | --- |
| `real` | 1 × 5 h | 97 KB | 19 | 316 | 2 206 | 1 450 |
| `long` | 1 × 24 h | 121 KB | 31 | 1 506 | 10 401 | 6 960 |
| `large` | 10 × 8 h | 811 KB | 209 | 1 574 | 6 843 | 2 320 |
| `extreme` | 25 × 24 h | 2.8 MB | 772 | 7 513 | 30 655 | 6 960 |

`real` is the record to beat. `large` is a Grossbrand with neighbouring Feuerwehren; `extreme`
is a whole Gemeinde on an Unwetter day. The Verlauf grows with √scale, because one KP writes it.
`fatIncident.test.ts` pins the calibration. It also checks that every preset passes the load gate
without a single dropped row, and that the schema-2 `objects` match what the app would derive.

## The tools

| Command | What it measures | Takes |
| --- | --- | --- |
| `pnpm bench` (`just bench`) | The pure hot paths, per preset: hydrate, derive, serialise, 409 merge, reminders, Verlauf search, one Replay scrub step (`src/lib/fatIncident.bench.ts`) | ~30 s |
| `just fat-perf [preset …]` | The whole thing (see below) against a real backend and a CPU-throttled Chromium (`e2e/fat-incident.perf.ts`, `scripts/fat-perf.sh`) | 1–5 min per preset |

`just fat-perf` stands up a **throwaway** stack for each preset: a fresh Postgres container and
the built app served by the backend (production shape, no Vite dev mode). It never touches the
dev database. Then it runs two phases.

- **Server phase:** it plays the incident in the way the crew would have built it up. That
  means 120 full-blob saves as the blob grows (`FAT_SAVES`), with the Verlauf and the audit chain
  growing alongside in outbox-sized batches. While that runs, a second "device" long-polls the
  workspace and a heartbeat asks for `/health` every 20 ms, so a save that stalls the event loop
  shows up. At the end it times the reads a late-joining device and the Replay make.
- **Browser phase:** it opens the incident in Chromium with the CPU throttled 4× (`FAT_CPU`,
  roughly a field tablet). It measures the time until the Karte has its symbols up, frame times
  while panning, how long another device's save takes to show up, and opening the Verlauf. It
  also counts the full-blob saves the app sends on its own while nobody edits anything. That
  count should be 0.

### Reading the numbers

- **Compare presets, not absolute values.** Headless Chromium draws WebGL in software, so
  panning is slower than on real hardware at every size. What matters is how a number grows
  from `real` to `large`.
- **Check the `machine load` line.** A run on a busy machine is not comparable to a quiet one.
  Here the same preset measured 4 s on a quiet machine and 14 s under load.
- `snapshot storage ≈` is extrapolated to the incident's full save count, one gzipped blob per
  save. The generator's random coordinates compress worse than real blobs (about 4× against about
  5×), so treat it as an upper bound. The `on disk` line under it is what the saves that were
  actually sent took.

## Results – 2026-09-26

Dev laptop (WSL, 12 cores), machine load 1–3, 4× CPU throttle in the browser.

| | `real` | `long` | `large` | `extreme` |
| --- | --- | --- | --- | --- |
| Save (PUT), p50 late in the incident | 65 ms | 69 ms | 243 ms | 671 ms |
| Another device has the new blob | 8 ms | 10 ms | 61 ms | 192 ms |
| Heartbeat p99 while saving | 14 ms | 13 ms | 73 ms | 174 ms |
| Open: read workspace | 23 ms | 23 ms | 106 ms | 312 ms |
| Replay: read all events | 43 ms / 0.4 MB | 224 ms / 1.7 MB | 307 ms / 2.4 MB | 1.3 s / 11 MB |
| Snapshot storage for the incident (before [compression](#snapshot-compression-26092026)) | 73 MB | 434 MB | 1.0 GB | 10.4 GB |
| … after, gzipped | 22 MB | 98 MB | 308 MB | 2.8 GB |
| Browser: open → Karte drawn | 3.8 s | 3.8 s | 4.8 s | 12.0 s |
| Browser: worst freeze while opening | 185 ms | 295 ms | 480 ms | 3.3 s |
| Browser: pan, frame p50 / p95 | 50 / 83 ms | 67 / 117 ms | 17 / 233 ms | 150 / 600 ms |
| Browser: another device's save visible | 252 ms | 364 ms | 1.0 s | 2.8 s |
| Browser: open the Verlauf | 575 ms | 813 ms | 1.1 s | 3.1 s |
| Browser: saves sent without an edit | 0 | 0 | 0 | 0 |

The pure paths (`pnpm bench`, unthrottled) grow linearly with the blob, and there is no
quadratic blow-up anywhere. At `extreme`, hydrate, serialise and the 409 merge each take about
20 ms, and a Verlauf search keystroke about 24 ms.

### What it found

1. **A long Einsatz costs nothing on the device.** `long` (24 h) opens, pans and syncs like `real`.
   What grows with time is storage and the Replay's event download. Neither affects the live
   picture.
2. **Ten times the busiest real Einsatz is still fine.** At `large`, saves take about 250 ms,
   another device's change shows up within a second, and the Karte is drawn in under 5 s on a
   tablet-class CPU.
3. **The first real limit is the Karte, at a few hundred symbols.** Every symbol is a DOM marker,
   and at `extreme` that is 2 600 elements. The Karte then takes 12 s to draw, panning runs at
   about 7 fps, and a remote change freezes the device for up to 3 s. If Einsätze of that size
   become realistic, the fix is to draw symbols in a map layer or drop the markers outside the
   viewport. The save path is not where the problem is.
4. **Snapshot storage grows with blob size × saves.** One uncompressed full blob per save
   (`audit.snapshot_workspace`) meant about 0.4 GB for a normal 24 h Einsatz, 1 GB at `large` and
   10 GB at `extreme`. The prod volume used 7 GB of 50 GB on 2026-09-26. **Fixed the same day:**
   snapshots are now stored gzipped (see below). Thinning them out instead is deliberately ruled
   out by `snapshot_workspace`.
5. **Save latency and the follower wake grow linearly with the blob** (about 0.25 ms per KB on
   this machine). That's acceptable up to `large`, and only becomes noticeable at `extreme`.

### Snapshot compression (26.09.2026)

Every save still writes one snapshot, now as gzipped compact JSON (`….json.gz`,
`app/audit.py · _encode_snapshot`). On prod's biggest real blobs gzip saves 3–6×, about 5× on
average. The generator's data compresses about 4×, which is what the "after" row above shows. The
reader tells old and new apart by gzip's magic bytes, not by the key. Snapshots written before
this stay plain `….json` and are read as they are; they are never rewritten, because backup
originals are immutable. `/snapshot`, `/state` and the Replay answer exactly as before.

Harness lessons, kept here so the next person doesn't relearn them:

- A drag that starts on a marker moves the symbol; it does not pan the map.
- Trupps left without contact all go überfällig at once, and each one saves.
- A request loop with no back-off on errors outlives its test and floods the next backend.
