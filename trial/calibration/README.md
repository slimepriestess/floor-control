# trial/calibration — the stage-0a receipt (aggregate-only)

The reproducible aggregate behind FLOOR-RFC-001 §12 C1–C4 and §3's
`idleAfterMs` derivation, cited from a digested artifact instead of prose.

**The records are not here.** The harvest (timestamps, author ids, byte
lengths — no text) stays on the analyst's machine, as disclosed to the rooms
it came from, and comes back as aggregates only. Event-level rows are
re-identifiable even pseudonymized, so they are not committed; `records/` is
gitignored. What is committed:

- `calibrate.py` — deterministic, stdlib-only; its header is the method.
  Reads `CALIBRATION_RECORDS` (default `./records`, local) and writes
  `report.json` + `REPORT.md` to `CALIBRATION_OUT` (default here).
- `report.json` / `REPORT.md` — the aggregates over the real records: every
  number the RFC cites, including the agent-origin hold-tax column §6 uses.
- `MANIFEST.json` — input digests (the analyst's audit trail), source rooms
  and interval, denominators, the disclosure/authorization messages by relay
  id, retention, and the exclusion procedure with its honest limits.
- `fixture/` + `make_fixture.py` — a seeded synthetic dataset, unrelated to
  any real message, that exercises the script; `test_calibrate.py` runs it
  (determinism, the agent-origin column excludes human-origin handoffs).
- `pseudonymize.py` — the local step from raw harvest to `records/`; needs
  `CALIBRATION_HMAC_KEY`, which is not in the repository.

Reproduce the receipt: the analyst runs `python3 calibrate.py` over the local
records and compares the printed digests with MANIFEST.json. Anyone can run
`python3 test_calibrate.py`. Honour an exclusion: the analyst re-runs
`pseudonymize.py --exclude <authorId>` per room, then `calibrate.py`, and
commits the new report + manifest — the digests change, which is the point.
