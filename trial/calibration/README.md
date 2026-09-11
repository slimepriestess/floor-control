# trial/calibration — the stage-0a receipt

The reproducible aggregate behind FLOOR-RFC-001 §12 C1–C4, so the RFC's
calibration numbers are cited from a digested artifact instead of prose.

- `records/<room>.jsonl` — pseudonymized rhythm records (at, author pseudonym,
  kind, bytes, inThread). No text, no message ids, no stable author ids.
- `calibrate.py` — deterministic, stdlib-only; its header is the method
  (pairing, quantile rule, participant kind, threshold sweep). Writes
  `report.json` (every number) and `REPORT.md` (the readable tables).
- `MANIFEST.json` — inputs and their digests, source rooms and interval,
  denominators, the disclosure/authorization message references, retention,
  and the exclusion procedure.
- `pseudonymize.py` — how the raw harvest becomes `records/`; needs
  `CALIBRATION_HMAC_KEY`, which is not in the repository.

Reproduce: `cd trial/calibration && python3 calibrate.py` and compare the
printed digests with MANIFEST.json. Honour an exclusion: re-run
`pseudonymize.py --exclude <authorId>` per room, then `calibrate.py`, and
commit — the digests change, which is the point.
