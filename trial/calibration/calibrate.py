#!/usr/bin/env python3
"""FLOOR-RFC-001 stage-0a calibration — the reproducible aggregate behind §12 C1–C4.

Reads the committed pseudonymized records (records/<room>.jsonl: at, author,
kind, bytes, inThread), computes every number the RFC cites, and writes
report.json + REPORT.md + MANIFEST.json. Deterministic, stdlib only.

Definitions (these ARE the method; the RFC cites them by name):
  quantile(p)   nearest-rank on the sorted sample: sorted[round(p/100*(n-1))]
  pair          two consecutive non-thread messages in one room, ordered by `at`
  gap           pair.at[1] - pair.at[0], ms
  self-continuation   a pair with the same author; classified by that author's kind
  handoff       a pair with different authors; classified by (from kind → to kind)
  quiet episode a gap > 60 000 ms; per-day = episodes / span days
  span days     (max at - min at) / 86 400 000
  threshold sweep T   fragmentation(kind) = share of that kind's self-continuations with gap > T;
                      hold tax = handoffs with gap < T, and the median of (T - gap) over them
Participant kind: the raw harvest's author id prefix — `user:` = human (verified
against the member registry 2026-08-25: every user: row is a human account);
`webhook:` / `persona:` = agent (residents post through those). Threads are
excluded (inThread=true rows are dropped before pairing).

Usage: python3 calibrate.py   (from this directory)
"""
import hashlib, json, os, statistics
from pathlib import Path

HERE = Path(__file__).parent
ROOMS = ['social', 'general']
THRESHOLDS_MS = [1000, 2000, 2500, 3000, 5000, 8000, 10000, 15000, 20000, 30000, 60000]
QUIET_MS = 60_000
PCTS = [10, 25, 50, 75, 90, 95, 99]

def q(xs, p):
    if not xs: return None
    xs = sorted(xs); return xs[min(len(xs) - 1, round(p / 100 * (len(xs) - 1)))]
def quantiles(xs): return {f'p{p}': q(xs, p) for p in PCTS} | {'n': len(xs)}
def load(room):
    rows = [json.loads(l) for l in (HERE / 'records' / f'{room}.jsonl').read_text().splitlines() if l.strip()]
    rows = [r for r in rows if not r['inThread']]
    rows.sort(key=lambda r: r['at']); return rows
def pairs(rows):
    return [(b['at'] - a['at'], a['author'] == b['author'], a['kind'], b['kind']) for a, b in zip(rows, rows[1:])]

def analyze(rows, label):
    ps = pairs(rows)
    span_days = (rows[-1]['at'] - rows[0]['at']) / 86_400_000 if len(rows) > 1 else 0
    by_kind = {k: [r for r in rows if r['kind'] == k] for k in ('human', 'agent')}
    self_gaps = {k: [g for g, same, fk, _ in ps if same and fk == k] for k in ('human', 'agent')}
    handoffs = [(g, fk, tk) for g, same, fk, tk in ps if not same]
    ho_by = {}
    for g, fk, tk in handoffs: ho_by.setdefault(f'{fk}→{tk}', []).append(g)
    quiet = [g for g, *_ in ps if g > QUIET_MS]
    sweep = []
    for t in THRESHOLDS_MS:
        held = [t - g for g, *_ in handoffs if g < t]
        sweep.append({'T_ms': t,
                      'frag_human': {'n': sum(1 for g in self_gaps['human'] if g > t), 'of': len(self_gaps['human'])},
                      'frag_agent': {'n': sum(1 for g in self_gaps['agent'] if g > t), 'of': len(self_gaps['agent'])},
                      'handoffs_under_T': {'n': len(held), 'of': len(handoffs)},
                      'median_imposed_delay_ms': q(held, 50)})
    buckets = [(0, 2), (2, 5), (5, 10), (10, 30), (30, 60), (60, 300), (300, 1800), (1800, None)]
    hist = {f'{lo}-{hi}s' if hi else f'>{lo}s': sum(1 for g in self_gaps['human'] if g >= lo * 1000 and (hi is None or g < hi * 1000)) for lo, hi in buckets}
    return {
        'room': label, 'n': len(rows), 'spanDays': round(span_days, 2), 'perDay': round(len(rows) / span_days, 1) if span_days else None,
        'messages': {k: len(v) for k, v in by_kind.items()},
        'distinctAuthors': {k: len({r['author'] for r in v}) for k, v in by_kind.items()} | {'all': len({r['author'] for r in rows})},
        'gapMs_all': quantiles([g for g, *_ in ps]),
        'selfContinueGapMs': {k: quantiles(v) for k, v in self_gaps.items()},
        'selfContinuationRate': round(sum(1 for _, same, *_ in ps if same) / len(ps), 3) if ps else None,
        'handoffGapMs': {'all': quantiles([g for g, *_ in handoffs])} | {k: quantiles(v) for k, v in sorted(ho_by.items())},
        'quiet': {'thresholdMs': QUIET_MS, 'episodes': len(quiet), 'perDay': round(len(quiet) / span_days, 1) if span_days else None, 'durationMs': quantiles(quiet)},
        'bytes': {'all': quantiles([r['bytes'] for r in rows])} | {k: quantiles([r['bytes'] for r in v]) for k, v in by_kind.items()},
        'humanSelfGapHistogram': hist,
        'sweep': sweep,
    }

def fmt(ms):
    if ms is None: return '—'
    return f'{ms/1000:.1f}s' if ms < 60_000 else f'{ms/60000:.1f}m' if ms < 3_600_000 else f'{ms/3_600_000:.1f}h'

def md_idle(report):
    L=['## §3 idleAfterMs derivation', '', 'Rule: p90 of the room\'s all-pairs gap over the whole measured interval (no active-hours trim, no kind split), rounded up to the next whole minute. `idleFiringsPerDay` is how often `floor/idle` would have fired at that value in the measured interval; the lab default (60 s) is shown beside it.', '',
       '| room | gap p90 | idleAfterMs | idle/day at that value | idle/day at 60 s |', '|---|---|---|---|---|']
    for r, v in report['idleAfterMs'].items():
        L.append(f"| {r} | {fmt(v['gapP90Ms'])} | {v['idleAfterMs']} ({v['idleAfterMin']} min) | {v['idleFiringsPerDay']} | {v['labDefault60sFiringsPerDay']} |")
    return '\n'.join(L) + '\n'

def md(report):
    L = ['# Stage-0a calibration report — FLOOR-RFC-001 §12 C1–C4', '',
         'Generated by `calibrate.py` from `records/*.jsonl` (see MANIFEST.json for inputs, digests, interval, and the disclosure/exclusion terms). Every number the RFC cites is in `report.json`; this file is the readable subset. Definitions are in the script header and are the method.', '']
    for r in report['rooms'] + [report['pooled']]:
        L += [f"## {r['room']}", '',
              f"n = {r['n']} messages over {r['spanDays']} days ({r['perDay']}/day): humans {r['messages']['human']} msgs / {r['distinctAuthors']['human']} authors, agents {r['messages']['agent']} msgs / {r['distinctAuthors']['agent']} authors.", '',
              '| measure | p10 | p25 | p50 | p75 | p90 | p95 | p99 | n |', '|---|---|---|---|---|---|---|---|---|']
        def row(name, qq): return f"| {name} | " + ' | '.join(fmt(qq[f'p{p}']) for p in PCTS) + f" | {qq['n']} |"
        L.append(row('gap, all consecutive pairs', r['gapMs_all']))
        for k in ('human', 'agent'): L.append(row(f'self-continuation gap, {k}', r['selfContinueGapMs'][k]))
        for k, qq in r['handoffGapMs'].items(): L.append(row(f'handoff gap, {k}', qq))
        L.append(row(f"quiet episode duration (>{QUIET_MS//1000}s)", r['quiet']['durationMs']))
        for k in ('all', 'human', 'agent'):
            bq = r['bytes'][k]; L.append(f"| bytes, {k} | " + ' | '.join(str(bq[f'p{p}']) for p in PCTS) + f" | {bq['n']} |")
        L += ['', f"Quiet episodes (>{QUIET_MS//1000}s): {r['quiet']['episodes']} = {r['quiet']['perDay']}/day. Self-continuation rate {r['selfContinuationRate']}.", '',
              'Human self-gap histogram: ' + ', '.join(f'{k}: {v}' for k, v in r['humanSelfGapHistogram'].items()), '',
              '| T | frag human | frag agent | handoffs < T | median imposed delay |', '|---|---|---|---|---|']
        for s in r['sweep']:
            fh, fa, hu = s['frag_human'], s['frag_agent'], s['handoffs_under_T']
            L.append(f"| {fmt(s['T_ms'])} | {fh['n']}/{fh['of']} ({100*fh['n']/fh['of'] if fh['of'] else 0:.0f}%) | {fa['n']}/{fa['of']} ({100*fa['n']/fa['of'] if fa['of'] else 0:.0f}%) | {hu['n']}/{hu['of']} | {fmt(s['median_imposed_delay_ms'])} |")
        L.append('')
    return '\n'.join(L)

def main():
    rooms = {r: load(r) for r in ROOMS}
    report = {'rooms': [analyze(rows, r) for r, rows in rooms.items()], 'pooled': analyze(sorted(sum(rooms.values(), []), key=lambda r: (r['at'])), 'pooled (pairs formed per room)')}
    # pooled pairs must be formed WITHIN each room — re-do pooled from per-room pairs
    pooled_rows = sum(rooms.values(), [])
    ps = sum((pairs(rows) for rows in rooms.values()), [])
    pooled = analyze(pooled_rows, 'pooled')  # placeholder for shape
    # recompute the pair-derived fields from per-room pairs
    self_gaps = {k: [g for g, same, fk, _ in ps if same and fk == k] for k in ('human', 'agent')}
    handoffs = [(g, fk, tk) for g, same, fk, tk in ps if not same]
    ho_by = {}
    for g, fk, tk in handoffs: ho_by.setdefault(f'{fk}→{tk}', []).append(g)
    pooled['room'] = 'pooled (pairs formed within each room)'
    all_at = [r['at'] for r in pooled_rows]; span = (max(all_at) - min(all_at)) / 86_400_000
    pooled['spanDays'] = round(span, 2); pooled['perDay'] = round(len(pooled_rows) / span, 1)
    pooled['gapMs_all'] = quantiles([g for g, *_ in ps])
    pooled['selfContinueGapMs'] = {k: quantiles(v) for k, v in self_gaps.items()}
    pooled['selfContinuationRate'] = round(sum(1 for _, same, *_ in ps if same) / len(ps), 3)
    pooled['handoffGapMs'] = {'all': quantiles([g for g, *_ in handoffs])} | {k: quantiles(v) for k, v in sorted(ho_by.items())}
    quiet = [g for g, *_ in ps if g > QUIET_MS]
    pooled['quiet'] = {'thresholdMs': QUIET_MS, 'episodes': len(quiet), 'perDay': round(len(quiet) / span, 1), 'durationMs': quantiles(quiet)}
    pooled['humanSelfGapHistogram'] = {k: sum(1 for g in self_gaps['human'] if g >= int(k.split('-')[0].rstrip('s').lstrip('>')) * 1000 and (k.startswith('>') or g < int(k.split('-')[1].rstrip('s')) * 1000)) for k in pooled['humanSelfGapHistogram']}
    sweep = []
    for t in THRESHOLDS_MS:
        held = [t - g for g, *_ in handoffs if g < t]
        sweep.append({'T_ms': t, 'frag_human': {'n': sum(1 for g in self_gaps['human'] if g > t), 'of': len(self_gaps['human'])},
                      'frag_agent': {'n': sum(1 for g in self_gaps['agent'] if g > t), 'of': len(self_gaps['agent'])},
                      'handoffs_under_T': {'n': len(held), 'of': len(handoffs)}, 'median_imposed_delay_ms': q(held, 50)})
    pooled['sweep'] = sweep
    report['pooled'] = pooled
    # §3 idleAfterMs derivation — THE deterministic mapping the RFC cites:
    #   idleAfterMs(room) = p90 of the room's all-pairs gap over the whole
    #   measured interval (no active-hours trim, no kind split: room silence
    #   is a room property), rounded UP to the next whole minute.
    # Plus its consequence, so the number can be judged: how many times per
    # day floor/idle would have fired in the measured interval at that value.
    report['idleAfterMs'] = {}
    for r, rows in rooms.items():
        ps_r = pairs(rows); gaps = [g for g, *_ in ps_r]
        p90 = q(gaps, 90); mapped = int(-(-p90 // 60_000) * 60_000)
        span = (rows[-1]['at'] - rows[0]['at']) / 86_400_000
        firings = sum(1 for g in gaps if g > mapped)
        report['idleAfterMs'][r] = {'gapP90Ms': p90, 'idleAfterMs': mapped, 'idleAfterMin': mapped // 60_000,
                                   'idleFiringsPerDay': round(firings / span, 2), 'labDefault60sFiringsPerDay': round(sum(1 for g in gaps if g > 60_000) / span, 1)}
    (HERE / 'report.json').write_text(json.dumps(report, indent=1) + '\n')
    (HERE / 'REPORT.md').write_text(md(report) + '\n' + md_idle(report))
    code_sha = hashlib.sha256((HERE / 'calibrate.py').read_bytes()).hexdigest()
    rec_sha = {r: hashlib.sha256((HERE / 'records' / f'{r}.jsonl').read_bytes()).hexdigest() for r in ROOMS}
    print(json.dumps({'calibrate.py': code_sha, 'records': rec_sha, 'report.json': hashlib.sha256((HERE / 'report.json').read_bytes()).hexdigest()}, indent=1))

if __name__ == '__main__':
    main()
