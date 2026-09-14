/**
 * FLOOR-RFC-001 §9 through the trial host: every refusal that reaches the
 * ledger arrives as a code from the closed set, never as the error's prose;
 * a participant's `reason=` text on the band is dropped before the book;
 * and grant-directed ops are the holder's (not-holder), bid-directed ops
 * the owner's. The rig is the loopback transport with the real host, real
 * service, real book, real clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FloorRoomHost } from '../trial/host.js';
import { LoopbackBus, LoopbackTransport } from '../trial/transport.js';
import { FluidFairnessLogic } from '../src/logics.js';
import { parseEvent } from '../trial/band.js';
import { assertClosedCodes } from '../src/codes.js';

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

function rig(acceptTtlMs?: { intent: number }) {
  const bus = new LoopbackBus();
  const ledger: Record<string, unknown>[] = [];
  const host = new FloorRoomHost(
    new LoopbackTransport(bus, 'floor-service', 'floor-service'),
    new FluidFairnessLogic({ speechLeaseMs: 1000, ...(acceptTtlMs ? { acceptTtlMs } : {}) }),
    { tickMs: 25, idleAfterMs: 60_000 },
  );
  // Keep the host's own validation in the path: wrap, don't replace.
  const inner = (host as unknown as { ledger(e: Record<string, unknown>): void }).ledger.bind(host);
  (host as unknown as { ledger(e: Record<string, unknown>): void }).ledger = (e) => { inner(e); ledger.push(e); };
  const controlEvents = () =>
    bus.log
      .filter((m) => m.surface === 'control' && m.authorId === 'floor-service')
      .map((m) => parseEvent(m.text))
      .filter((e): e is NonNullable<ReturnType<typeof parseEvent>> => e !== null);
  const opErrors = () => ledger.filter((e) => e.kind === 'op-error') as Array<{ op: string; participantId: string; cause: string }>;
  return { bus, host, ledger, controlEvents, opErrors };
}

async function joinAndBid(bus: LoopbackBus, controlEvents: () => Array<{ type: string; fields: Record<string, string> }>, who: string) {
  bus.post(who, who, 'control', '!floor join');
  await until(() => controlEvents().some((e) => e.type === 'joined' && e.fields.participant === who), 2_000);
  bus.post(who, who, 'control', '!floor bid readiness=intent');
  assert.ok(await until(() => controlEvents().some((e) => e.type === 'grant/offered'), 2_000), 'offer emitted');
  return controlEvents().find((e) => e.type === 'grant/offered')!.fields.grantId;
}

test('unknown-op: `!floor frobnicate` is ledgered, not swallowed as chatter', async () => {
  const { bus, host, opErrors, ledger } = rig();
  host.start();
  try {
    bus.post('ra-human', 'ra-human', 'control', '!floor frobnicate now');
    assert.ok(await until(() => opErrors().length > 0, 2_000));
    assert.deepEqual(opErrors().map((e) => [e.op, e.cause]), [['frobnicate', 'unknown-op']]);
    assert.ok(ledger.some((e) => e.kind === 'op' && e.op === 'frobnicate'), 'the op row records the verb as written');
  } finally { host.stop(); }
});

test('rank: a bid before joining lacks standing', async () => {
  const { bus, host, opErrors } = rig();
  host.start();
  try {
    bus.post('bot-a', 'bot-a', 'control', '!floor bid readiness=intent');
    assert.ok(await until(() => opErrors().length > 0, 2_000));
    assert.deepEqual(opErrors().map((e) => [e.op, e.cause]), [['bid', 'rank']]);
  } finally { host.stop(); }
});

test('not-holder: grant-directed ops are the holder\'s; bid-directed ops are the owner\'s', async () => {
  const { bus, host, opErrors, controlEvents } = rig();
  host.start();
  try {
    const grantId = await joinAndBid(bus, controlEvents, 'bot-a');
    bus.post('bot-b', 'bot-b', 'control', '!floor join');
    await until(() => controlEvents().some((e) => e.type === 'joined' && e.fields.participant === 'bot-b'), 2_000);
    bus.post('bot-b', 'bot-b', 'control', `!floor accept ${grantId}`);
    bus.post('bot-b', 'bot-b', 'control', `!floor decline ${grantId}`);
    bus.post('bot-b', 'bot-b', 'control', `!floor release ${grantId}`);
    bus.post('bot-b', 'bot-b', 'control', `!floor continue ${grantId} +5s`);
    bus.post('bot-b', 'bot-b', 'control', '!floor cancel b1');
    bus.post('bot-b', 'bot-b', 'control', '!floor amend b1 readiness=urgent');
    assert.ok(await until(() => opErrors().length >= 6, 2_000), `six refusals, got ${opErrors().length}`);
    assert.deepEqual(
      opErrors().map((e) => [e.participantId, e.op, e.cause]),
      [['bot-b', 'accept', 'not-holder'], ['bot-b', 'decline', 'not-holder'], ['bot-b', 'release', 'not-holder'],
       ['bot-b', 'continue', 'not-holder'], ['bot-b', 'cancel', 'not-holder'], ['bot-b', 'amend', 'not-holder']],
    );
    // The holder's own ops still work: nothing above touched the grant.
    bus.post('bot-a', 'bot-a', 'control', `!floor accept ${grantId}`);
    assert.ok(await until(() => controlEvents().some((e) => e.type === 'grant/accepted'), 2_000), 'the holder accepts');
  } finally { host.stop(); }
});

test('accept/refused cause=accept-ttl-elapsed: a late accept on your own expired offer, one row, no prose', async () => {
  const { bus, host, ledger, controlEvents, opErrors } = rig({ intent: 150 });
  host.start();
  try {
    const grantId = await joinAndBid(bus, controlEvents, 'bot-a');
    assert.ok(await until(() => controlEvents().some((e) => e.type === 'grant/offer-expired'), 2_000), 'offer expired under the tick');
    bus.post('bot-a', 'bot-a', 'control', `!floor accept ${grantId}`);
    assert.ok(await until(() => ledger.some((e) => e.kind === 'accept/refused'), 2_000), 'accept/refused ledgered');
    const row = ledger.find((e) => e.kind === 'accept/refused') as { cause: string; grantId: string; participantId: string };
    assert.equal(row.cause, 'accept-ttl-elapsed');
    assert.equal(row.grantId, grantId);
    assert.equal(row.participantId, 'bot-a');
    assert.equal(opErrors().length, 0, 'not a not-holder: it was their offer');
    assert.ok(controlEvents().some((e) => e.type === 'accept/refused' && e.fields.cause === 'accept-ttl-elapsed'), 'the band says the same');
  } finally { host.stop(); }
});

test('a participant\'s `reason=` text is dropped before the book: the decline is cause=participant', async () => {
  const { bus, host, ledger, controlEvents } = rig();
  host.start();
  try {
    const grantId = await joinAndBid(bus, controlEvents, 'bot-a');
    bus.post('bot-a', 'bot-a', 'control', `!floor decline ${grantId} reason=changed_my_mind_about_everything`);
    assert.ok(await until(() => controlEvents().some((e) => e.type === 'grant/declined'), 2_000));
    const declined = ledger.find((e) => e.kind === 'event' && e.type === 'grant/declined') as { data: Record<string, unknown> };
    assert.equal(declined.data.cause, 'participant');
    assert.equal(declined.data.reason, undefined);
    assert.ok(!JSON.stringify(ledger).includes('changed_my_mind'), 'the text never reached the ledger');
    // stale-head is the one code a participant may assert on the band.
    bus.post('bot-a', 'bot-a', 'control', '!floor bid readiness=prepared');
    assert.ok(await until(() => controlEvents().filter((e) => e.type === 'grant/offered').length >= 2, 2_000));
    const g2 = controlEvents().filter((e) => e.type === 'grant/offered')[1].fields.grantId;
    bus.post('bot-a', 'bot-a', 'control', `!floor decline ${g2} reason=stale-head`);
    assert.ok(await until(() => ledger.some((e) => e.kind === 'event' && e.type === 'bid/suspended'), 2_000));
    const d2 = ledger.filter((e) => e.kind === 'event' && e.type === 'grant/declined') as Array<{ data: Record<string, unknown> }>;
    assert.equal(d2[1].data.cause, 'stale-head');
  } finally { host.stop(); }
});

test('the host\'s ledger seam refuses a bad row itself — not only the book upstream of it', () => {
  const { host } = rig();
  const write = (host as unknown as { ledger(e: Record<string, unknown>): void }).ledger;
  assert.throws(() => write({ kind: 'op-error', at: 1, op: 'accept', cause: 'because' }), /closed set/);
  assert.throws(() => write({ kind: 'idle', at: 1, reason: 'quiet' }), /closed set/);
  assert.doesNotThrow(() => write({ kind: 'idle', at: 1, quietMs: 5 }));
});

test('every ledger row the host wrote passes §9, and none carries a reason field', async () => {
  const { bus, host, ledger, controlEvents } = rig();
  host.start();
  try {
    const grantId = await joinAndBid(bus, controlEvents, 'bot-a');
    bus.post('bot-a', 'bot-a', 'control', `!floor accept ${grantId}`);
    await until(() => controlEvents().some((e) => e.type === 'grant/accepted'), 2_000);
    bus.post('bot-a', 'bot-a', 'room', 'a turn, taken');
    bus.post('bot-a', 'bot-a', 'control', `!floor release ${grantId}`);
    await until(() => controlEvents().some((e) => e.type === 'grant/released'), 2_000);
    bus.post('ra-human', 'ra-human', 'control', '!floor accept room#1#g999');
    await until(() => ledger.some((e) => e.kind === 'op-error'), 2_000);
    assert.ok(ledger.length > 5);
    for (const row of ledger) {
      assert.doesNotThrow(() => assertClosedCodes(row), JSON.stringify(row));
      assert.ok(!('reason' in row), JSON.stringify(row));
    }
    assert.ok(ledger.some((e) => e.kind === 'event' && e.type === 'bid/consumed' && (e.data as { by: string }).by === 'accepted'), 'the turn consumed the bid');
  } finally { host.stop(); }
});
