/**
 * FLOOR-RFC-001 §6 — emission coalescing: the burst hold, as one lifecycle
 * with one owner. The nine conformance vectors the RFC names (rev-10 item
 * 3), executed against the shipped service with explicit clocks, plus the
 * wiring through the trial host on the loopback transport.
 *
 * The observable is the book's own event log: one `grant/released` per
 * emission, a `grant/offered` for the next bidder only after it, and no
 * event the hold invented — an arbiter release IS a release.
 */
import { describe, it, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { FloorService } from '../src/service.js';
import { FloorBook } from '../src/book.js';
import { FluidFairnessLogic } from '../src/logics.js';
import { FloorRoomHost } from '../trial/host.js';
import { LoopbackBus, LoopbackTransport } from '../trial/transport.js';
import { parseEvent } from '../trial/band.js';
import type { Bid } from '../src/types.js';

const T0 = 1_754_000_000_000;
const LEASE = 30_000;
const BURST = 2_500;

function room(svc: FloorService, opts: ConstructorParameters<typeof FluidFairnessLogic>[0] = {}) {
  return svc.registerRoom('eidoverse://commons/hearth', 'auth:sequencer', new FluidFairnessLogic({ speechLeaseMs: LEASE, burstReleaseMs: BURST, ...opts }), T0);
}
function bid(book: FloorBook, participantId: string, bidId: string, now: number, kind: Bid['readinessKind'] = 'prepared') {
  return book.createBid({ participantId, bidId, readinessKind: kind, createdAt: now, expiresAt: null }, now);
}
/** offer + accept for `who`, returning the accepted grant. */
function take(svc: FloorService, r: ReturnType<FloorService['registerRoom']>, who: string, bidId: string, t: number) {
  bid(r.book, who, bidId, t);
  const g = svc.arbitrate(r.roomId, t + 1).grant!;
  assert.equal(g.participantId, who);
  return svc.accept(r.roomId, g.grantId, t + 2);
}
const speak = (svc: FloorService, roomId: string, who: string, at: number, kind: 'agent' | 'human' = 'agent', delivered = true) =>
  svc.noteSpeech(roomId, { participantId: who, kind, at, delivered });
const types = (r: ReturnType<FloorService['registerRoom']>) => r.book.eventLog().map((e) => e.type);
const count = (r: ReturnType<FloorService['registerRoom']>, t: string) => types(r).filter((x) => x === t).length;

let svc: FloorService;
beforeEach(() => { svc = new FloorService('pe_burst'); });

describe('§6 burst hold — the nine conformance vectors', () => {
  it('V1: two sends 1 s apart inside one grant → one emission, one `released` 2.5 s after the second', () => {
    const r = room(svc);
    const g = take(svc, r, 'a', 'b1', T0);
    const t1 = T0 + 10, t2 = t1 + 1_000;
    speak(svc, r.roomId, 'a', t1);
    speak(svc, r.roomId, 'a', t2);
    assert.equal(svc.burstHold(r.roomId)?.releaseAt, t2 + BURST, 'the second send moved the hold');
    svc.arbitrate(r.roomId, t2 + BURST - 1);
    assert.equal(r.book.liveGrant?.grantId, g.grantId, 'still held at 2.499 s of silence');
    svc.arbitrate(r.roomId, t2 + BURST);
    assert.equal(r.book.liveGrant, null, 'released at 2.5 s of silence');
    assert.equal(r.book.receiptFor(g.grantId)?.terminal, 'released');
    assert.equal(count(r, 'grant/released'), 1, 'one emission, one terminal');
    assert.equal(svc.burstHold(r.roomId), null);
  });

  it('V2a: explicit `release` after the first send → terminal immediately, whatever the hold says', () => {
    const r = room(svc);
    const g = take(svc, r, 'a', 'b1', T0);
    speak(svc, r.roomId, 'a', T0 + 10);
    assert.ok(svc.burstHold(r.roomId), 'hold armed');
    svc.release(r.roomId, g.grantId, T0 + 11);
    assert.equal(r.book.receiptFor(g.grantId)?.at, T0 + 11, 'released NOW, not at +2.5 s');
    assert.equal(svc.burstHold(r.roomId), null, 'the arbiter never ignores or delays a received release');
  });

  it('V2b: a second send after the explicit release is ordinary room speech — it revives nothing', () => {
    const r = room(svc);
    const g = take(svc, r, 'a', 'b1', T0);
    speak(svc, r.roomId, 'a', T0 + 10);
    svc.release(r.roomId, g.grantId, T0 + 11);
    const after = speak(svc, r.roomId, 'a', T0 + 12);
    assert.equal(after, null, 'no hold: the grant is terminal');
    svc.arbitrate(r.roomId, T0 + 13);
    assert.equal(r.book.liveGrant, null, 'and no grant came back');
    assert.equal(count(r, 'grant/released'), 1);
  });

  it('V3: the next bidder is offered only after the terminal — same arbitration, released before offered', () => {
    const r = room(svc);
    take(svc, r, 'a', 'b1', T0);
    bid(r.book, 'b', 'b2', T0 + 5);
    speak(svc, r.roomId, 'a', T0 + 10);
    const held = svc.arbitrate(r.roomId, T0 + 1_000);
    assert.deepEqual(held.decision, { kind: 'hold', cause: 'floor-occupied' }, 'b waits while a holds');
    const next = svc.arbitrate(r.roomId, T0 + 10 + BURST);
    assert.equal(next.grant?.participantId, 'b', 'b offered once a\'s emission ended');
    const seq = types(r);
    assert.ok(seq.lastIndexOf('grant/released') < seq.lastIndexOf('grant/offered'), 'released precedes offered in the ledger');
  });

  it('V4: a transport-failed send extends nothing', () => {
    const r = room(svc);
    take(svc, r, 'a', 'b1', T0);
    speak(svc, r.roomId, 'a', T0 + 10);
    const before = svc.burstHold(r.roomId)!;
    const after = speak(svc, r.roomId, 'a', T0 + 2_000, 'agent', false);
    assert.deepEqual(after, before, 'the failed send is not delivered and moves nothing');
    svc.arbitrate(r.roomId, T0 + 10 + BURST);
    assert.equal(r.book.liveGrant, null, 'released on the FIRST send\'s clock');
  });

  it('V5: holder disconnect before any send → `lease-expired` on the lease clock; no hold exists to shorten it', () => {
    const r = room(svc);
    const g = take(svc, r, 'a', 'b1', T0);
    assert.equal(svc.burstHold(r.roomId), null);
    svc.arbitrate(r.roomId, T0 + 2 + LEASE - 1);
    assert.equal(r.book.liveGrant?.grantId, g.grantId);
    svc.arbitrate(r.roomId, T0 + 2 + LEASE);
    assert.equal(r.book.receiptFor(g.grantId)?.terminal, 'lease-expired');
  });

  it('V5b (what the arbiter cannot know): a holder that vanishes AFTER a send is released at burstReleaseMs — silence is silence', () => {
    // §6 says the arbiter cannot distinguish a crash from a finished burst,
    // and it does not try: the floor comes back sooner, costing nobody.
    const r = room(svc);
    const g = take(svc, r, 'a', 'b1', T0);
    speak(svc, r.roomId, 'a', T0 + 10);
    svc.arbitrate(r.roomId, T0 + 10 + BURST);
    assert.equal(r.book.receiptFor(g.grantId)?.terminal, 'released');
  });

  it('V6: a burst that would extend past leaseUntil → `lease-expired`, not extension (the hold is a debounce inside the lease)', () => {
    const r = room(svc);
    const g = take(svc, r, 'a', 'b1', T0);
    const leaseUntil = g.leaseUntil;
    speak(svc, r.roomId, 'a', leaseUntil - 1_000);
    assert.equal(svc.burstHold(r.roomId)?.releaseAt, leaseUntil, 'ceiling: never past leaseUntil');
    svc.arbitrate(r.roomId, leaseUntil);
    assert.equal(r.book.receiptFor(g.grantId)?.terminal, 'lease-expired', 'the lease clock terminates, not the hold');
    assert.equal(count(r, 'grant/released'), 0);
    assert.equal(svc.burstHold(r.roomId), null);
  });

  it('V7: restart mid-burst → epoch death, no hold survives; logic swap likewise', () => {
    const r = room(svc);
    take(svc, r, 'a', 'b1', T0);
    speak(svc, r.roomId, 'a', T0 + 10);
    assert.ok(svc.burstHold(r.roomId));
    const svc2 = FloorService.restore('pe_burst2', [{ roomId: r.roomId, bindings: r.bindings, logic: r.logic, durableBids: r.book.listBids() }], T0 + 20);
    assert.equal(svc2.burstHold(r.roomId), null, 'restart: no hold');
    assert.equal(svc2.room(r.roomId).book.liveGrant, null, 'restart: no grant either (§2.3)');
    // Logic swap on the live service: the grant dies with the epoch and the hold with it.
    const r2 = room(svc);
    take(svc, r2, 'a', 'b1', T0);
    speak(svc, r2.roomId, 'a', T0 + 10);
    r2.book.activateContract(new FluidFairnessLogic({ speechLeaseMs: LEASE, burstReleaseMs: BURST }).contract, T0 + 11);
    svc.arbitrate(r2.roomId, T0 + 12);
    assert.equal(svc.burstHold(r2.roomId), null, 'logic swap: the hold\'s generation is stale and it is dropped');
    assert.equal(count(r2, 'grant/released'), 0, 'dropped, not released — the revoke was the terminal');
  });

  it('V8 (negative): a participant whose name reads like an agent but whose identity class is human → no hold', () => {
    const r = room(svc);
    const g = take(svc, r, 'agent-bot-9000', 'b1', T0);
    const h = speak(svc, r.roomId, 'agent-bot-9000', T0 + 10, 'human');
    assert.equal(h, null, 'kind is structural; the name is not consulted');
    svc.arbitrate(r.roomId, T0 + 10 + BURST + 1);
    assert.equal(r.book.liveGrant?.grantId, g.grantId, 'the lease clock governs a human holder');
  });

  it('V9: speech by anyone else neither extends nor ends the hold; interruption is the logic\'s business', () => {
    const r = room(svc);
    take(svc, r, 'a', 'b1', T0);
    speak(svc, r.roomId, 'a', T0 + 10);
    const before = svc.burstHold(r.roomId)!;
    speak(svc, r.roomId, 'heckler', T0 + 1_000);
    assert.deepEqual(svc.burstHold(r.roomId), before);
    svc.arbitrate(r.roomId, T0 + 10 + BURST);
    assert.equal(r.book.liveGrant, null, 'released on the holder\'s own silence clock');
  });
});

describe('§6 burst hold — binding and contract edges', () => {
  it('an offered-but-unaccepted grant holds nothing: speech before accept is not a burst', () => {
    const r = room(svc);
    bid(r.book, 'a', 'b1', T0);
    svc.arbitrate(r.roomId, T0 + 1);
    assert.equal(speak(svc, r.roomId, 'a', T0 + 2), null);
  });

  it('a contract with burstReleaseMs 0 never holds; a narrowed contract holds only the listed readiness kinds', () => {
    const r0 = room(svc, { burstReleaseMs: 0 });
    take(svc, r0, 'a', 'b1', T0);
    assert.equal(speak(svc, r0.roomId, 'a', T0 + 10), null);
    const r1 = room(svc, { burstHoldReadiness: ['prepared'] });
    take(svc, r1, 'a', 'b1', T0); // prepared
    assert.ok(speak(svc, r1.roomId, 'a', T0 + 10));
    svc.release(r1.roomId, r1.book.liveGrant!.grantId, T0 + 11);
    bid(r1.book, 'c', 'b3', T0 + 12, 'intent');
    const g = svc.arbitrate(r1.roomId, T0 + 13).grant!;
    svc.accept(r1.roomId, g.grantId, T0 + 14);
    assert.equal(speak(svc, r1.roomId, 'c', T0 + 15), null, 'intent is outside the narrowed set');
  });

  it('the arbiter release is the same receipt an explicit release makes: terminal released, no invented event', () => {
    const r = room(svc);
    take(svc, r, 'a', 'b1', T0);
    speak(svc, r.roomId, 'a', T0 + 10);
    svc.arbitrate(r.roomId, T0 + 10 + BURST);
    const rel = r.book.eventLog().find((e) => e.type === 'grant/released')!;
    assert.deepEqual(Object.keys(rel.data).sort(), ['grantId', 'terminal']);
    const known = new Set(['room/registered', 'contract/changed', 'bid/created', 'grant/offered', 'grant/accepted', 'bid/consumed', 'grant/released']);
    for (const t of types(r)) assert.ok(known.has(t), `unexpected event ${t}`);
  });
});

// ── wiring: the trial host feeds room speech with the transport's identity class ──
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

test('host: an agent holder\'s room speech arms the hold and the arbiter releases after burstReleaseMs of silence', async () => {
  const bus = new LoopbackBus();
  const host = new FloorRoomHost(
    new LoopbackTransport(bus, 'floor-service', 'floor-service'),
    new FluidFairnessLogic({ speechLeaseMs: 5_000, burstReleaseMs: 300 }),
    { tickMs: 25, idleAfterMs: 60_000 },
  );
  const events = () => bus.log.filter((m) => m.surface === 'control' && m.authorId === 'floor-service').map((m) => parseEvent(m.text)).filter((e): e is NonNullable<ReturnType<typeof parseEvent>> => e !== null);
  host.start();
  try {
    bus.post('bot-a', 'bot-a', 'control', '!floor join', undefined, 'agent');
    await until(() => events().some((e) => e.type === 'joined'), 2_000);
    bus.post('bot-a', 'bot-a', 'control', '!floor bid readiness=prepared', undefined, 'agent');
    assert.ok(await until(() => events().some((e) => e.type === 'grant/offered'), 2_000));
    const grantId = events().find((e) => e.type === 'grant/offered')!.fields.grantId;
    bus.post('bot-a', 'bot-a', 'control', `!floor accept ${grantId}`, undefined, 'agent');
    assert.ok(await until(() => events().some((e) => e.type === 'grant/accepted'), 2_000));
    bus.post('bot-a', 'bot-a', 'room', 'first line of the turn', undefined, 'agent');
    await new Promise((r) => setTimeout(r, 150));
    bus.post('bot-a', 'bot-a', 'room', 'second line, 150 ms later', undefined, 'agent');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(host.service.burstHold(host.roomId), 'hold armed by the holder\'s speech');
    assert.ok(host.book.liveGrant, 'still held 100 ms after the second line');
    assert.ok(await until(() => events().some((e) => e.type === 'grant/released'), 2_000), 'released after 300 ms of silence');
    assert.equal(host.book.receiptFor(grantId)?.terminal, 'released');
    assert.equal(events().filter((e) => e.type === 'grant/released').length, 1, 'one emission');
    assert.equal(host.violations.length, 0, 'the holder\'s own speech is not a violation');
  } finally {
    host.stop();
  }
});

test('host: a human-class holder (transport says human) gets no hold, even with an agent-looking name', async () => {
  const bus = new LoopbackBus();
  const host = new FloorRoomHost(
    new LoopbackTransport(bus, 'floor-service', 'floor-service'),
    new FluidFairnessLogic({ speechLeaseMs: 5_000, burstReleaseMs: 200 }),
    { tickMs: 25, idleAfterMs: 60_000 },
  );
  const events = () => bus.log.filter((m) => m.surface === 'control' && m.authorId === 'floor-service').map((m) => parseEvent(m.text)).filter((e): e is NonNullable<ReturnType<typeof parseEvent>> => e !== null);
  host.start();
  try {
    bus.post('u1', 'GPT-Bot-Prime', 'control', '!floor join', undefined, 'human');
    await until(() => events().some((e) => e.type === 'joined'), 2_000);
    bus.post('u1', 'GPT-Bot-Prime', 'control', '!floor bid readiness=manual', undefined, 'human');
    assert.ok(await until(() => events().some((e) => e.type === 'grant/offered'), 2_000));
    const grantId = events().find((e) => e.type === 'grant/offered')!.fields.grantId;
    bus.post('u1', 'GPT-Bot-Prime', 'control', `!floor accept ${grantId}`, undefined, 'human');
    await until(() => events().some((e) => e.type === 'grant/accepted'), 2_000);
    bus.post('u1', 'GPT-Bot-Prime', 'room', 'a human speaks', undefined, 'human');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(host.service.burstHold(host.roomId), null, 'no hold for a human-class holder');
    assert.ok(host.book.liveGrant, 'still holding on the lease clock');
  } finally {
    host.stop();
  }
});
