/**
 * FLOOR-RFC-001 §3 — `idleAfterMs` is a static, digested contract value
 * with a STATED provenance (rev-10 item 2); and §2.1 — a contract that
 * wants a bound on the bid envelope's `size` has one, enforced by the
 * book (rev-10 item 5).
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';

import { FloorService } from '../src/service.js';
import { FluidFairnessLogic, IDLE_CALIBRATION, LAB_DEFAULT_IDLE, MEASURED_TURN_SIZE } from '../src/logics.js';
import { digestContract } from '../src/contract.js';
import { FloorRoomHost } from '../trial/host.js';
import { LoopbackBus, LoopbackTransport } from '../trial/transport.js';
import { parseEvent } from '../trial/band.js';

const T0 = 1_754_000_000_000;

describe('§3 idleAfterMs — a contract value with a stated provenance', () => {
  it('the lab default is labelled as such, in the contract, and is 60 s', () => {
    const c = new FluidFairnessLogic().contract;
    assert.equal(c.knobs.idleAfterMs, 60_000);
    assert.deepEqual(c.knobs.idleAfterProvenance, LAB_DEFAULT_IDLE.idleAfterProvenance);
    assert.equal((c.knobs.idleAfterProvenance as { kind: string }).kind, 'lab-default');
  });

  it('a value without a provenance (or a provenance without a value) is refused at construction', () => {
    assert.throws(() => new FluidFairnessLogic({ idleAfterMs: 1_440_000 }), /travel together/);
    assert.throws(() => new FluidFairnessLogic({ idleAfterProvenance: LAB_DEFAULT_IDLE.idleAfterProvenance }), /travel together/);
  });

  it('a re-calibration is a contract revision: changing idleAfterMs changes the digest', () => {
    const a = new FluidFairnessLogic().contract;
    const b = new FluidFairnessLogic({ ...IDLE_CALIBRATION.social }).contract;
    assert.notEqual(digestContract(a), digestContract(b));
    // And so does the provenance alone — the origin is part of the terms.
    const c = new FluidFairnessLogic({ idleAfterMs: 60_000, idleAfterProvenance: { kind: 'operator', note: 'same number, different story' } }).contract;
    assert.notEqual(digestContract(a), digestContract(c));
  });

  it('the measured presets carry the receipt: room, rule, and the report digest the manifest declares', () => {
    for (const room of ['social', 'general'] as const) {
      const p = IDLE_CALIBRATION[room].idleAfterProvenance;
      assert.equal(p.kind, 'measured');
      if (p.kind !== 'measured') return;
      assert.match(p.reportSha256, /^[0-9a-f]{64}$/);
      assert.match(p.rule, /p90/);
      assert.match(p.receipt, /MANIFEST\.json/);
    }
    assert.equal(IDLE_CALIBRATION.social.idleAfterMs, 24 * 60_000, 'social: gap p90 23.5 min → 24 min');
    assert.equal(IDLE_CALIBRATION.general.idleAfterMs, 142 * 60_000, '#general: gap p90 2.4 h → 142 min');
    const ps = IDLE_CALIBRATION.social.idleAfterProvenance, pg = IDLE_CALIBRATION.general.idleAfterProvenance;
    assert.equal(ps.kind === 'measured' && pg.kind === 'measured' && ps.reportSha256 === pg.reportSha256, true, 'one receipt, two rooms');
  });

  it('a logic swap to a re-calibrated contract is an epoch change under live grants (the digest moved)', () => {
    const svc = new FloorService('pe_prov');
    const r = svc.registerRoom('x', 'auth', new FluidFairnessLogic(), T0);
    const e1 = r.book.currentContract!.logicEpoch;
    r.book.activateContract(new FluidFairnessLogic({ ...IDLE_CALIBRATION.social }).contract, T0 + 1);
    assert.equal(r.book.currentContract!.logicEpoch, e1 + 1);
    assert.equal(r.book.currentContract!.contract.knobs.idleAfterMs, 1_440_000);
  });
});

describe('§2.1 size — a contract-level bound, enforced by the book', () => {
  const env = (bidId: string, size?: number) => ({
    participantId: 'a', bidId, readinessKind: 'prepared' as const, createdAt: T0, expiresAt: null,
    payload: size === undefined ? { digest: 'sha256:abc' } : { digest: 'sha256:abc', size },
  });

  it('no bound declared → any size passes (the envelope defines size, not a limit)', () => {
    const svc = new FloorService('pe_size');
    const r = svc.registerRoom('x', 'auth', new FluidFairnessLogic(), T0);
    assert.equal(r.book.currentContract!.contract.knobs.maxBidSizeBytes, undefined);
    assert.doesNotThrow(() => r.book.createBid(env('b1', 10_000_000), T0));
  });

  it('a bound refuses an oversize bid at create and at amend, admits one at the bound, and ignores a bid that declares no size', () => {
    const svc = new FloorService('pe_size');
    const bound = 2 * MEASURED_TURN_SIZE.p90Bytes;
    const r = svc.registerRoom('x', 'auth', new FluidFairnessLogic({ maxBidSizeBytes: bound }), T0);
    assert.equal(r.book.currentContract!.contract.knobs.maxBidSizeBytes, bound);
    assert.match(String(r.book.currentContract!.contract.bidFields.size), /bound/);
    assert.throws(() => r.book.createBid(env('b1', bound + 1), T0), /exceeds the contract's bound/);
    assert.equal(r.book.listBids().length, 0, 'refused before the bid existed');
    assert.doesNotThrow(() => r.book.createBid(env('b1', bound), T0 + 1));
    assert.throws(() => r.book.amendBid('b1', { payload: { digest: 'sha256:def', size: bound + 1 } }, T0 + 2), /exceeds/);
    assert.equal(r.book.listBids()[0].revision, 1, 'the refused amend did not bump the revision');
    assert.doesNotThrow(() => r.book.createBid({ ...env('b2'), participantId: 'b' }, T0 + 3), 'no declared size: not measured');
  });

  it('the bound is part of the terms: it changes the digest, and a bad bound is refused', () => {
    assert.notEqual(digestContract(new FluidFairnessLogic().contract), digestContract(new FluidFairnessLogic({ maxBidSizeBytes: 4096 }).contract));
    assert.throws(() => new FluidFairnessLogic({ maxBidSizeBytes: 0 }), /positive/);
    assert.throws(() => new FluidFairnessLogic({ maxBidSizeBytes: Infinity }), /positive/);
  });
});

// ── through the host ──
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}
function rig(logic: FluidFairnessLogic, hostIdle?: number) {
  const bus = new LoopbackBus();
  const ledger: Record<string, unknown>[] = [];
  const host = new FloorRoomHost(new LoopbackTransport(bus, 'floor-service', 'floor-service'), logic, { tickMs: 25, ...(hostIdle !== undefined ? { idleAfterMs: hostIdle } : {}) });
  const inner = (host as unknown as { ledger(e: Record<string, unknown>): void }).ledger.bind(host);
  (host as unknown as { ledger(e: Record<string, unknown>): void }).ledger = (e) => { inner(e); ledger.push(e); };
  const events = () => bus.log.filter((m) => m.surface === 'control' && m.authorId === 'floor-service').map((m) => parseEvent(m.text)).filter((e): e is NonNullable<ReturnType<typeof parseEvent>> => e !== null);
  return { bus, host, ledger, events };
}

test('host: the quiet lease is the contract\'s, not the host option\'s; the idle row says which and whence', async () => {
  // Contract says 150 ms (operator-labelled); the host option says a minute. The contract wins.
  const { host, ledger, events } = rig(new FluidFairnessLogic({ idleAfterMs: 150, idleAfterProvenance: { kind: 'operator', note: 'test rig' } }), 60_000);
  host.start();
  try {
    assert.ok(await until(() => events().some((e) => e.type === 'floor/idle'), 3_000), 'idle fired on the contract\'s 150 ms, not the host\'s 60 s');
    const row = ledger.find((e) => e.kind === 'idle') as { idleAfterMs: number; provenance: string };
    assert.equal(row.idleAfterMs, 150);
    assert.equal(row.provenance, 'operator');
  } finally { host.stop(); }
});

test('host: `size=` on the band reaches the envelope; an oversize bid is refused before it exists, a non-numeric size is a malformed op', async () => {
  const { bus, host, ledger, events } = rig(new FluidFairnessLogic({ maxBidSizeBytes: 4096 }));
  host.start();
  try {
    bus.post('bot-a', 'bot-a', 'control', '!floor join');
    await until(() => events().some((e) => e.type === 'joined'), 2_000);
    bus.post('bot-a', 'bot-a', 'control', '!floor bid readiness=prepared digest=sha256:aaa size=5000');
    assert.ok(await until(() => ledger.some((e) => e.kind === 'host-invariant'), 2_000), 'the refusal reached the ledger');
    assert.equal(host.book.listBids().length, 0, 'no bid was created');
    bus.post('bot-a', 'bot-a', 'control', '!floor bid readiness=prepared digest=sha256:aaa size=lots');
    assert.ok(await until(() => ledger.some((e) => e.kind === 'op-error' && (e as { cause: string }).cause === 'unknown-op'), 2_000));
    bus.post('bot-a', 'bot-a', 'control', '!floor bid readiness=prepared digest=sha256:aaa size=1900');
    assert.ok(await until(() => events().some((e) => e.type === 'grant/offered'), 2_000), 'a bid at the measured p90 is admitted and offered');
    assert.equal(host.book.listBids()[0].payload?.size, 1900);
  } finally { host.stop(); }
});
