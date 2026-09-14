/**
 * FLOOR-RFC-001 §9 — the closed vocabulary, executed.
 *
 * Two named vectors the RFC asks for by name: every code in the table is
 * accepted by the schema (accept-known) and one value outside it per field
 * is rejected (reject-unknown). Then the book's own emissions are walked
 * through the live product path so that the table and the code cannot
 * drift apart without one of these going red. And the exactly-once
 * terminal (§12 0b, `bid/consumed by=`): one per bid revision, never two,
 * on every path that ends a bid.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { FloorService } from '../src/service.js';
import { FloorBook } from '../src/book.js';
import { FluidFairnessLogic, ChairedLogic } from '../src/logics.js';
import {
  CLOSED_CODES,
  CLOSED_TERMINALS,
  assertClosedCodes,
  ClosedCodeViolation,
  FloorRefusal,
  HOLD_CAUSES,
} from '../src/codes.js';
import type { Bid, FloorEvent } from '../src/types.js';

const T0 = 1_754_000_000_000;

function fluidRoom(svc: FloorService) {
  return svc.registerRoom('eidoverse://commons/hearth', 'auth:sequencer', new FluidFairnessLogic({ leaseMs: 10_000 }), T0);
}
function bid(book: FloorBook, participantId: string, bidId: string, now: number, kind: Bid['readinessKind'] = 'intent') {
  return book.createBid({ participantId, bidId, readinessKind: kind, createdAt: now, expiresAt: null }, now);
}
const consumedOf = (book: FloorBook, bidId: string) =>
  book.eventLog().filter((e) => e.type === 'bid/consumed' && e.data.bidId === bidId);

let svc: FloorService;
beforeEach(() => { svc = new FloorService('pe_codes'); });

describe('§9 accept-known: every code in the table passes the schema', () => {
  for (const [event, row] of Object.entries(CLOSED_CODES)) {
    if (row.field === null) {
      it(`${event} carries no code and is accepted bare`, () => {
        assert.doesNotThrow(() => assertClosedCodes({ kind: event, at: T0 }));
      });
      continue;
    }
    if (row.codes === null) {
      it(`${event}.${row.field} is an identifier, accepted when present`, () => {
        assert.doesNotThrow(() => assertClosedCodes({ kind: event, at: T0, [row.field!]: 'accept' }));
      });
      continue;
    }
    for (const code of row.codes) {
      it(`${event}.${row.field} = ${code}`, () => {
        assert.doesNotThrow(() => assertClosedCodes({ kind: event, at: T0, [row.field!]: code }));
        // The same row as a bare book event (type + data), which is how the
        // book itself emits.
        assert.doesNotThrow(() => assertClosedCodes({ type: event, data: { [row.field!]: code } }));
      });
    }
  }
  for (const terminal of CLOSED_TERMINALS) {
    it(`terminal receipt = ${terminal}`, () => {
      // revoked and declined carry a cause of their own (§9 rows above);
      // the other terminals carry only the terminal.
      const cause = terminal === 'revoked' ? { cause: 'chair' } : terminal === 'declined' ? { cause: 'participant' } : {};
      assert.doesNotThrow(() => assertClosedCodes({ type: `grant/${terminal}`, data: { terminal, ...cause } }));
    });
  }
});

describe('§9 reject-unknown: one value outside the set per field is refused', () => {
  for (const [event, row] of Object.entries(CLOSED_CODES)) {
    if (row.field === null || row.codes === null) continue;
    it(`${event}.${row.field} = "not-a-code" is rejected`, () => {
      assert.throws(() => assertClosedCodes({ kind: event, at: T0, [row.field!]: 'not-a-code' }), ClosedCodeViolation);
      assert.throws(() => assertClosedCodes({ type: event, data: { [row.field!]: 'not-a-code' } }), ClosedCodeViolation);
    });
    it(`${event} with the ${row.field} field missing is rejected`, () => {
      assert.throws(() => assertClosedCodes({ kind: event, at: T0 }), ClosedCodeViolation);
    });
  }
  it('a terminal outside the set is rejected', () => {
    assert.throws(() => assertClosedCodes({ type: 'grant/released', data: { terminal: 'vanished' } }), ClosedCodeViolation);
  });
  it('op-unconsented must not carry args (the verb only)', () => {
    assert.throws(() => assertClosedCodes({ kind: 'op-unconsented', op: 'bid', args: { readiness: 'intent' } }), ClosedCodeViolation);
  });
  it('free text never enters: a `reason` key is rejected on ANY record', () => {
    assert.throws(() => assertClosedCodes({ kind: 'op-error', cause: 'not-holder', reason: 'because' }), ClosedCodeViolation);
    assert.throws(() => assertClosedCodes({ type: 'grant/declined', data: { cause: 'participant', reason: 'content withdrawn' } }), ClosedCodeViolation);
    assert.throws(() => assertClosedCodes({ kind: 'idle', at: T0, reason: 'quiet' }), ClosedCodeViolation);
  });
  it('the arbitration hold causes are exactly the table (a logic cannot invent one)', () => {
    assert.deepEqual([...HOLD_CAUSES].sort(), ['chair-discretion', 'cooldown', 'floor-occupied', 'no-open-bids']);
  });
});

describe('the book emits only table codes — walked through the product path', () => {
  /** Every coded field on every event the book emitted passes the schema
   *  (the book already asserted this at emit; here it is asserted again
   *  from outside, so a future emit that bypassed the check would still be
   *  caught). */
  function allCoded(events: readonly FloorEvent[]) {
    for (const e of events) assert.doesNotThrow(() => assertClosedCodes(e), `${e.type} ${JSON.stringify(e.data)}`);
  }

  it('hold decisions are codes: floor-occupied, no-open-bids, cooldown, chair-discretion', () => {
    const r = fluidRoom(svc);
    const none = svc.arbitrate(r.roomId, T0 + 1).decision;
    assert.deepEqual(none, { kind: 'hold', cause: 'no-open-bids' });
    bid(r.book, 'a', 'b1', T0 + 2);
    svc.arbitrate(r.roomId, T0 + 3);
    assert.deepEqual(svc.arbitrate(r.roomId, T0 + 4).decision, { kind: 'hold', cause: 'floor-occupied' });
    // cooldown: a lease expiry strikes the participant; their next bid holds.
    const g = r.book.liveGrant!;
    r.book.acceptGrant(g.grantId, T0 + 5);
    svc.arbitrate(r.roomId, T0 + 5 + 10_001); // lease-expired under the tick
    bid(r.book, 'a', 'b2', T0 + 5 + 10_002);
    assert.deepEqual(svc.arbitrate(r.roomId, T0 + 5 + 10_003).decision, { kind: 'hold', cause: 'cooldown' });
    const chaired = svc.registerRoom('x', 'auth', new ChairedLogic('antra'), T0);
    assert.deepEqual(svc.arbitrate(chaired.roomId, T0 + 1).decision, { kind: 'hold', cause: 'chair-discretion' });
  });

  it('bid/staled cause=contract-change and grant/revoked cause=epoch-death on a logic swap', () => {
    const r = fluidRoom(svc);
    bid(r.book, 'a', 'b1', T0 + 1);
    svc.arbitrate(r.roomId, T0 + 2);
    r.book.activateContract(new ChairedLogic('antra').contract, T0 + 3);
    const revoked = r.book.eventLog().find((e) => e.type === 'grant/revoked')!;
    assert.equal(revoked.data.cause, 'epoch-death');
    assert.equal(revoked.data.reason, undefined);
    const staled = r.book.eventLog().find((e) => e.type === 'bid/staled')!;
    assert.equal(staled.data.cause, 'contract-change');
    allCoded(r.book.eventLog());
  });

  it('bid/staled cause=process-restart on restore', () => {
    const r = fluidRoom(svc);
    const b = bid(r.book, 'a', 'b1', T0 + 1);
    const book2 = FloorBook.restore(r.roomId, 'pe_codes2', [b], T0 + 10);
    const staled = book2.eventLog().find((e) => e.type === 'bid/staled')!;
    assert.equal(staled.data.cause, 'process-restart');
    allCoded(book2.eventLog());
  });

  it('bid/cancelled cause=expired (tick) / participant (owner) / spent-out-of-band (0b)', () => {
    const r = fluidRoom(svc);
    r.book.createBid({ participantId: 'a', bidId: 'b1', readinessKind: 'intent', createdAt: T0 + 1, expiresAt: T0 + 100 }, T0 + 1);
    bid(r.book, 'b', 'b2', T0 + 2);
    bid(r.book, 'c', 'b3', T0 + 3);
    r.book.tick(T0 + 101);
    r.book.cancelBid('b2', T0 + 102);
    r.book.cancelBid('b3', T0 + 103, 'spent-out-of-band');
    const causes = r.book.eventLog().filter((e) => e.type === 'bid/cancelled').map((e) => e.data.cause);
    assert.deepEqual(causes, ['expired', 'participant', 'spent-out-of-band']);
    allCoded(r.book.eventLog());
  });

  it('grant/declined cause=participant by default; the chair revoke carries cause=chair + actor, no operator string', () => {
    const r = svc.registerRoom('x', 'auth', new ChairedLogic('antra'), T0);
    const b = bid(r.book, 'a', 'b1', T0 + 1, 'manual');
    const g = svc.chairGrant(r.roomId, 'antra', b.bidId, b.revision, { acceptTtlMs: 20_000, speechLeaseMs: 10_000 }, T0 + 2);
    svc.decline(r.roomId, g.grantId, T0 + 3);
    const declined = r.book.eventLog().find((e) => e.type === 'grant/declined')!;
    assert.equal(declined.data.cause, 'participant');
    const g2 = svc.chairGrant(r.roomId, 'antra', b.bidId, b.revision, { acceptTtlMs: 20_000, speechLeaseMs: 10_000 }, T0 + 4);
    const receipt = svc.chairRevoke(r.roomId, 'antra', g2.grantId, T0 + 5);
    assert.equal(receipt.cause, 'chair');
    assert.equal((receipt as { reason?: string }).reason, undefined);
    const revoked = r.book.eventLog().find((e) => e.type === 'grant/revoked')!;
    assert.equal(revoked.data.cause, 'chair');
    assert.equal(revoked.data.actor, 'antra', 'the acting identity is its own field, never part of the code');
    allCoded(r.book.eventLog());
  });

  it('a non-chair revoke is refused with op-error code rank', () => {
    const r = svc.registerRoom('x', 'auth', new ChairedLogic('antra'), T0);
    const b = bid(r.book, 'a', 'b1', T0 + 1, 'manual');
    const g = svc.chairGrant(r.roomId, 'antra', b.bidId, b.revision, { acceptTtlMs: 20_000, speechLeaseMs: 10_000 }, T0 + 2);
    assert.throws(() => svc.chairRevoke(r.roomId, 'mica', g.grantId, T0 + 3), (e: unknown) => e instanceof FloorRefusal && e.code === 'rank');
  });

  it('a late accept is refused with op-error code late-accept, and the bid is still open (never consumed)', () => {
    const r = fluidRoom(svc);
    bid(r.book, 'a', 'b1', T0 + 1);
    const g = svc.arbitrate(r.roomId, T0 + 2).grant!;
    assert.throws(() => svc.accept(r.roomId, g.grantId, g.acceptBy + 1), (e: unknown) => e instanceof FloorRefusal && e.code === 'late-accept');
    assert.equal(consumedOf(r.book, 'b1').length, 0);
  });

  it('rebidding while holding a granted bid is refused with op-error code one-bid-rule', () => {
    const r = fluidRoom(svc);
    bid(r.book, 'a', 'b1', T0 + 1);
    svc.arbitrate(r.roomId, T0 + 2);
    assert.throws(() => bid(r.book, 'a', 'b2', T0 + 3), (e: unknown) => e instanceof FloorRefusal && e.code === 'one-bid-rule');
  });

  it('the book refuses to emit an unknown code at the source', () => {
    const r = fluidRoom(svc);
    bid(r.book, 'a', 'b1', T0 + 1);
    // Reach the emitter with a value the table does not contain.
    assert.throws(
      () => r.book.cancelBid('b1', T0 + 2, 'because-i-said-so' as never),
      ClosedCodeViolation,
    );
  });
});

describe('§12 0b exactly-once: one bid/consumed per revision, on every path', () => {
  it('accepted: consumed at acceptance; release/revoke/lease-expiry never reopen it', () => {
    const r = fluidRoom(svc);
    bid(r.book, 'a', 'b1', T0 + 1);
    const g = svc.arbitrate(r.roomId, T0 + 2).grant!;
    assert.equal(consumedOf(r.book, 'b1').length, 0, 'an offer consumes nothing');
    r.book.acceptGrant(g.grantId, T0 + 3);
    const c = consumedOf(r.book, 'b1');
    assert.equal(c.length, 1);
    assert.equal(c[0].data.by, 'accepted');
    assert.equal(c[0].data.revision, 1);
    svc.arbitrate(r.roomId, T0 + 3 + 10_001); // lease-expired
    assert.equal(r.book.listBids()[0].state, 'consumed', 'the turn happened; the revision is never re-offered');
    assert.equal(consumedOf(r.book, 'b1').length, 1, 'still exactly one');
    assert.deepEqual(svc.arbitrate(r.roomId, T0 + 3 + 10_002).decision, { kind: 'hold', cause: 'no-open-bids' });
  });

  it('released without a formal accept: the release is the holder\'s acceptance and release in one act — consumed once', () => {
    const r = fluidRoom(svc);
    bid(r.book, 'a', 'b1', T0 + 1);
    const g = svc.arbitrate(r.roomId, T0 + 2).grant!;
    svc.release(r.roomId, g.grantId, T0 + 3);
    assert.deepEqual(consumedOf(r.book, 'b1').map((e) => e.data.by), ['accepted']);
    assert.equal(r.book.listBids()[0].state, 'consumed');
  });

  it('accepted then revoked by the chair: consumed once, at acceptance', () => {
    const r = svc.registerRoom('x', 'auth', new ChairedLogic('antra'), T0);
    const b = bid(r.book, 'a', 'b1', T0 + 1, 'manual');
    const g = svc.chairGrant(r.roomId, 'antra', b.bidId, b.revision, { acceptTtlMs: 20_000, speechLeaseMs: 10_000 }, T0 + 2);
    r.book.acceptGrant(g.grantId, T0 + 3);
    svc.chairRevoke(r.roomId, 'antra', g.grantId, T0 + 4);
    assert.equal(consumedOf(r.book, 'b1').length, 1);
    assert.equal(r.book.listBids()[0].state, 'consumed');
  });

  it('declined / offer-expired / revoked-while-offered: NOT consumed — nobody took a turn; the bid returns', () => {
    const r = svc.registerRoom('x', 'auth', new ChairedLogic('antra'), T0);
    const b = bid(r.book, 'a', 'b1', T0 + 1, 'manual');
    const g1 = svc.chairGrant(r.roomId, 'antra', b.bidId, b.revision, { acceptTtlMs: 20_000, speechLeaseMs: 10_000 }, T0 + 2);
    svc.decline(r.roomId, g1.grantId, T0 + 3);
    assert.equal(r.book.listBids()[0].state, 'open');
    const g2 = svc.chairGrant(r.roomId, 'antra', b.bidId, b.revision, { acceptTtlMs: 20_000, speechLeaseMs: 10_000 }, T0 + 4);
    r.book.tick(g2.acceptBy + 1);
    assert.equal(r.book.listBids()[0].state, 'open');
    const g3 = svc.chairGrant(r.roomId, 'antra', b.bidId, b.revision, { acceptTtlMs: 20_000, speechLeaseMs: 10_000 }, T0 + 30_000);
    svc.chairRevoke(r.roomId, 'antra', g3.grantId, T0 + 30_001);
    assert.equal(r.book.listBids()[0].state, 'open');
    assert.equal(consumedOf(r.book, 'b1').length, 0);
  });

  it('cancelled by owner / expired / spent-out-of-band: each consumes once with its own `by`', () => {
    const r = fluidRoom(svc);
    r.book.createBid({ participantId: 'a', bidId: 'b1', readinessKind: 'intent', createdAt: T0 + 1, expiresAt: T0 + 100 }, T0 + 1);
    bid(r.book, 'b', 'b2', T0 + 2);
    bid(r.book, 'c', 'b3', T0 + 3);
    r.book.tick(T0 + 101);
    r.book.cancelBid('b2', T0 + 102);
    r.book.cancelBid('b3', T0 + 103, 'spent-out-of-band');
    assert.deepEqual(consumedOf(r.book, 'b1').map((e) => e.data.by), ['expired']);
    assert.deepEqual(consumedOf(r.book, 'b2').map((e) => e.data.by), ['cancelled']);
    assert.deepEqual(consumedOf(r.book, 'b3').map((e) => e.data.by), ['spent-out-of-band']);
  });

  it('staled consumes the REVISION; re-affirmation is a new revision that can be consumed again — never the same one twice', () => {
    const r = fluidRoom(svc);
    bid(r.book, 'a', 'b1', T0 + 1);
    r.book.activateContract(new FluidFairnessLogic({ leaseMs: 10_000 }).contract, T0 + 2);
    let c = consumedOf(r.book, 'b1');
    assert.deepEqual(c.map((e) => [e.data.by, e.data.revision]), [['staled', 1]]);
    r.book.amendBid('b1', {}, T0 + 3); // re-affirmation: revision 2
    const g = svc.arbitrate(r.roomId, T0 + 4).grant!;
    r.book.acceptGrant(g.grantId, T0 + 5);
    c = consumedOf(r.book, 'b1');
    assert.deepEqual(c.map((e) => [e.data.by, e.data.revision]), [['staled', 1], ['accepted', 2]]);
    const keys = new Set(c.map((e) => `${e.data.bidId}#${e.data.revision}`));
    assert.equal(keys.size, c.length, 'no (bidId, revision) is consumed twice');
  });

  it('lapsed consumes once (three ignored offers)', () => {
    const r = fluidRoom(svc);
    bid(r.book, 'ghost', 'b1', T0 + 1);
    let t = T0 + 2;
    for (let i = 0; i < 3; i++) {
      const g = svc.arbitrate(r.roomId, t).grant!;
      t = g.acceptBy + 2;
      svc.arbitrate(r.roomId, t);
      t += 100_000; // past the capped backoff (lease 10s → cap 80s)
    }
    assert.deepEqual(consumedOf(r.book, 'b1').map((e) => e.data.by), ['lapsed']);
  });

  it('the whole log carries at most one bid/consumed per (bidId, revision) — the invariant, stated once over everything above', () => {
    const r = fluidRoom(svc);
    bid(r.book, 'a', 'b1', T0 + 1);
    const g = svc.arbitrate(r.roomId, T0 + 2).grant!;
    r.book.acceptGrant(g.grantId, T0 + 3);
    svc.release(r.roomId, g.grantId, T0 + 4);
    bid(r.book, 'b', 'b2', T0 + 5);
    r.book.cancelBid('b2', T0 + 6);
    const seen = new Map<string, number>();
    for (const e of r.book.eventLog()) {
      if (e.type !== 'bid/consumed') continue;
      const k = `${e.data.bidId}#${e.data.revision}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    assert.ok([...seen.values()].every((n) => n === 1), JSON.stringify([...seen]));
    assert.equal(r.book.eventLog().filter((e) => e.type === 'book/invariant').length, 0);
  });
});
