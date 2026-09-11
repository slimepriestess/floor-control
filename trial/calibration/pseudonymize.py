#!/usr/bin/env python3
"""Turn a raw rhythm harvest (timestamp / author id / message id / bytes /
thread flag) into the committed calibration records.

Why a separate step: the raw harvest carries STABLE author and message ids —
rehydratable references, not anonymized aggregates (RFC §12, stage-0
obligations). The committed records replace both with keyed pseudonyms so the
calibration is reproducible from the repository without the repository
holding a lookup into anyone's history. The key lives outside the repo
(CALIBRATION_HMAC_KEY); a later exclusion is honoured by re-running this step
with the excluded author dropped and re-running calibrate.py, which changes
the manifest digests — the published aggregate is thereby invalidated, not
silently kept.

Usage: CALIBRATION_HMAC_KEY=… python3 pseudonymize.py <room> <raw.jsonl> [--exclude author:id ...]
Writes records/<room>.jsonl and prints the raw input's sha256 for the manifest.
"""
import hashlib, hmac, json, os, sys
from pathlib import Path
HERE = Path(__file__).parent

def main():
    args = sys.argv[1:]
    excludes = set()
    while '--exclude' in args:
        i = args.index('--exclude'); excludes.add(args[i + 1]); del args[i:i + 2]
    room, raw_path = args
    key = os.environ.get('CALIBRATION_HMAC_KEY', '').encode()
    if not key:
        sys.exit('CALIBRATION_HMAC_KEY is required (kept outside the repo)')
    raw = open(raw_path, 'rb').read()
    rows = [json.loads(l) for l in raw.decode().splitlines() if l.strip()]
    out = []
    for r in sorted(rows, key=lambda r: r['at']):
        a = r['authorId']
        if a in excludes:
            continue
        kind = 'human' if a.startswith('user:') else 'agent'
        pseudo = hmac.new(key, a.encode(), hashlib.sha256).hexdigest()[:12]
        out.append({'at': r['at'], 'author': f'{kind[0]}-{pseudo}', 'kind': kind,
                    'bytes': int(r.get('bytes', 0)), 'inThread': bool(r.get('inThread', False))})
    (HERE / 'records').mkdir(exist_ok=True)
    with open(HERE / 'records' / f'{room}.jsonl', 'w') as f:
        for o in out:
            f.write(json.dumps(o, separators=(',', ':')) + '\n')
    print(json.dumps({'room': room, 'rawSha256': hashlib.sha256(raw).hexdigest(),
                      'rawRows': len(rows), 'kept': len(out), 'excluded': sorted(excludes)}))

if __name__ == '__main__':
    main()
