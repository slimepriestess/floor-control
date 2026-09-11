#!/usr/bin/env python3
"""A SYNTHETIC rhythm fixture for exercising calibrate.py — no relation to any
real room, message, or person. Generated from a fixed seed so the fixture is
reproducible byte-for-byte; regenerate with `python3 make_fixture.py`.

Shape (loosely the measured rooms, deliberately not fitted to them): humans
post with long gaps, agents post in sub-second bursts, and the schedule PLANTS
three facts test_calibrate.py checks: two human-origin handoffs under 2.5 s
(one human→agent, one human→human), and NO agent-origin handoff under 2.5 s.
"""
import json, random
from pathlib import Path
HERE = Path(__file__).parent
def room(seed, humans, agents, n, t0):
    rng = random.Random(seed); rows = []; t = t0
    who = [(f'h-{i}', 'human') for i in range(humans)] + [(f'a-{i}', 'agent') for i in range(agents)]
    last = None
    while len(rows) < n:
        a, k = rng.choice(who)
        if last and last[1] == 'agent' and a != last[0] and k != 'agent':
            t += rng.randint(3_000, 90_000)            # agent-origin handoffs never under 2.5 s
        elif last and a != last[0]:
            t += rng.randint(2_600, 400_000)
        elif k == 'agent':
            t += rng.randint(200, 900)                 # the harness burst
        else:
            t += rng.randint(8_000, 1_200_000)
        if rng.random() < 0.02: t += rng.randint(3_600_000, 8 * 3_600_000)   # a night
        rows.append({'at': t, 'author': a, 'kind': k, 'bytes': rng.randint(20, 300) if k == 'human' else rng.randint(300, 1900), 'inThread': False})
        last = (a, k)
    return rows
def plant(rows, i, gap_ms, a, ka, b, kb):
    """Force rows[i], rows[i+1] to be a (a→b) handoff gap_ms apart; shifts what follows."""
    rows[i]['author'], rows[i]['kind'] = a, ka
    rows[i+1]['author'], rows[i+1]['kind'] = b, kb
    delta = rows[i]['at'] + gap_ms - rows[i+1]['at']
    for r in rows[i+1:]: r['at'] += delta
def main():
    social = room(11, 5, 9, 540, 1_700_000_000_000)
    general = room(12, 5, 7, 150, 1_700_000_000_000)
    plant(social, 100, 1_702, 'h-0', 'human', 'a-0', 'agent')      # human→agent under 2.5 s
    plant(social, 300, 1_416, 'h-1', 'human', 'h-2', 'human')      # human→human under 2.5 s
    (HERE / 'fixture').mkdir(exist_ok=True)
    for name, rows in (('social', social), ('general', general)):
        with open(HERE / 'fixture' / f'{name}.jsonl', 'w') as f:
            for r in rows: f.write(json.dumps(r, separators=(',', ':')) + '\n')
    print('fixture written')
if __name__ == '__main__': main()
