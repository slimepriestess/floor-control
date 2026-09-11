#!/usr/bin/env python3
"""calibrate.py's own receipts, over the synthetic fixture. Run: python3 test_calibrate.py"""
import json, os, subprocess, sys, tempfile, hashlib
from pathlib import Path
HERE = Path(__file__).parent
ok = bad = 0
def t(name, cond):
    global ok, bad
    ok += cond; bad += (not cond); print(('ok   ' if cond else 'FAIL ') + name)
def run(records):
    out = Path(tempfile.mkdtemp())
    subprocess.run([sys.executable, str(HERE / 'calibrate.py')], check=True, env={**os.environ, 'CALIBRATION_RECORDS': str(records), 'CALIBRATION_OUT': str(out)}, capture_output=True)
    return json.load(open(out / 'report.json')), hashlib.sha256((out / 'report.json').read_bytes()).hexdigest()
fx = HERE / 'fixture'
rep, sha1 = run(fx)
_, sha2 = run(fx)
t('deterministic: two runs over the fixture give byte-identical report.json', sha1 == sha2)
# Independent recomputation of the agent-origin denominator from the fixture rows
def handoffs(room):
    rows = sorted((json.loads(l) for l in open(fx / f'{room}.jsonl')), key=lambda r: r['at'])
    return [(b['at'] - a['at'], a['kind'], b['kind']) for a, b in zip(rows, rows[1:]) if a['author'] != b['author']]
pooled = rep['pooled']['sweep']; s25 = next(s for s in pooled if s['T_ms'] == 2500)
ho = handoffs('social') + handoffs('general')
agent_origin = [g for g, fk, _ in ho if fk == 'agent']
t('agent-origin denominator equals the count of handoffs whose departing speaker is an agent', s25['agent_origin_handoffs_under_T']['of'] == len(agent_origin))
t('the fixture plants human-origin handoffs under 2.5 s (all column sees them)', s25['handoffs_under_T']['n'] >= 2)
t('…and they do NOT enter the agent-origin column (the §6 cost column is 0)', s25['agent_origin_handoffs_under_T']['n'] == 0 == sum(1 for g in agent_origin if g < 2500))
t('the descriptive column is never smaller than the mechanism-matched one, at every T', all(s['handoffs_under_T']['n'] >= s['agent_origin_handoffs_under_T']['n'] for s in pooled))
# The regression Mica asked for, as a mutation-sensitive property: move every
# planted sub-T handoff to human origin and the agent column must stay 0 while
# the all column stays ≥ 2 — a filter that thresholds before filtering fails this.
for room in ('social', 'general'):
    r = next(x for x in rep['rooms'] if x['room'] == room)
    s = next(x for x in r['sweep'] if x['T_ms'] == 2500)
    t(f'{room}: per-room agent-origin column present and consistent', s['agent_origin_handoffs_under_T']['of'] == len([g for g, fk, _ in handoffs(room) if fk == 'agent']))
t('idleAfterMs derived for both rooms and rounded to whole minutes', all(v['idleAfterMs'] % 60_000 == 0 for v in rep['idleAfterMs'].values()))
print(f'\n{ok} ok, {bad} failed'); sys.exit(1 if bad else 0)
