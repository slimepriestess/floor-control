/**
 * FloorRoomHost — binds one room (a transport's two surfaces) to a
 * FloorService and runs the live arbitration loop the conformance suite can't:
 * real clock, real participants, real latencies.
 *
 * The host is the room's arbiter identity (§9): it connects as itself, posts
 * structured events to the control surface, and never speaks in the room
 * band. It also audits voluntary compliance — speech in the room by a joined
 * participant who does not hold the floor is logged as a violation event, not
 * blocked (§1: the service is a consumer of the room, not a gate).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FloorService } from '../src/service.js';
import { FluidFairnessLogic, type Logic } from '../src/logics.js';
import type { Grant } from '../src/types.js';
import { assertClosedCodes, FloorRefusal, type OpErrorCause } from '../src/codes.js';
import { parseOp, parseDuration, eventLine, type FloorOp } from './band.js';
import type { InboundMessage, RoomTransport } from './transport.js';

export interface HostOptions {
  tickMs?: number;
  /** JSONL ledger path; unset = in-memory only. */
  ledgerPath?: string;
  /** participantIds exempt from compliance audit (humans, per Session 1). */
  exemptIds?: string[];
  /** Quiet-room liveness (FINDING-2, Mica's shape): after this much silence
   *  with a free floor and an empty book, the host emits a logged
   *  `floor/idle` event that wake policies and standing-ready clients can
   *  target — liveness never depends on an unlogged human nudge. */
  idleAfterMs?: number;
  /** Clock-gap witness threshold (host-sleep ruling). Default
   *  max(10s, 10×tickMs); the loopback suspend/resume scenario shrinks it. */
  clockGapThresholdMs?: number;
}

export class FloorRoomHost {
  readonly service: FloorService;
  readonly roomId: string;
  /** participantId → acknowledged contractDigest. */
  private joined = new Map<string, string>();
  private bidCounter = 0;
  private lastSeq = 0;
  private lastRoomMessageId: string | null = null;
  /** Exact head each offer was stamped with — a stale-head decline blocks
   *  that head, not whatever the room head is by decline-processing time. */
  private offerHeads = new Map<string, string>();
  private lastActivityAt = Date.now();
  private lastActivityCause = 'startup';
  private lastIdleAt = 0;
  /** floor/idle fires ONCE per quiet epoch, then disarms; it re-arms only on
   *  an actual liveness transition (speech, book activity), with the cause
   *  recorded — a genuinely quiet room must not get a periodic wake source
   *  out of its liveness primitive (Mica, 2026-08-11). */
  private idleArmed = true;
  /** Liveness is processing-order, not timestamp-order. Message stamps are
   *  receipts of when a thing was said; the transition the idle machinery
   *  cares about is when the host processed it. Comparing stamps to the tick
   *  clock silently swallows a genuine join whose stamp ties with (or, via
   *  redelivery, precedes) the last emission — the room then never re-arms
   *  and a newcomer waits forever (Mica's S6 2/12 reproduction, 2026-08-17).
   *  So re-arm rides these monotonic counters; timestamps stay for quietMs
   *  receipts only. */
  private activitySeq = 0;
  private idleSeenSeq = 0;
  idleEmissions = 0;
  readonly idleRearms: Array<{ at: number; cause: string }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly violations: Array<{ at: number; participantId: string; messageId: string }> = [];

  constructor(
    private transport: RoomTransport,
    private logic: Logic,
    private opts: HostOptions = {},
  ) {
    this.service = new FloorService(`trial-${Date.now().toString(36)}`);
    const room = this.service.registerRoom(transport.locator, transport.provenance, logic, Date.now());
    this.roomId = room.roomId;
    if (opts.ledgerPath) mkdirSync(dirname(opts.ledgerPath), { recursive: true });
  }

  start(): void {
    this.transport.onMessage((m) => this.onMessage(m));
    this.timer = setInterval(() => this.pump(), this.opts.tickMs ?? 500);
    const c = this.book.currentContract!;
    void this.transport.sendControl(
      eventLine('room/registered', {
        roomId: this.roomId,
        logic: c.contract.logicId,
        epoch: c.logicEpoch,
        digest: c.contractDigest.slice(0, 12),
        hint: '!floor_join_to_participate',
      }),
    );
    // Humans live in the room channel, not the control thread — from there a
    // freshly (re)started arbiter is indistinguishable from a dead one, and
    // ops sent into a restart gap vanish without trace (observed 2026-08-18:
    // a join+speech landed in the seven minutes between epoch stop and
    // relaunch). The banner marks, in the humans' band, the exact moment
    // listening begins; anything you sent before it, the floor never heard.
    // The banner is room speech to every other participant — a prepared
    // bidder will correctly bind its content to it — so the arbiter must
    // count it as the room head too. Self-filtering its own echo left
    // lastRoomMessageId null, every offer said head=none, and the sole
    // prepared bot declined stale-head into an unbounded re-offer loop
    // (FINDING-14, epoch 2026-08-18T20-47: ~100 six-second cycles, born
    // two seconds after launch). Guard: never clobber real speech that
    // arrived while the send was in flight.
    void this.transport
      .sendRoom(
        `floor service listening from this message onward (${c.contract.logicId} epoch ${c.logicEpoch}) — \`!floor join\` to participate; ops sent while the service was down were not seen.`,
      )
      .then((id) => {
        if (id && this.lastRoomMessageId === null) this.lastRoomMessageId = id;
      });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get book() {
    return this.service.room(this.roomId).book;
  }

  // ── inbound ──

  private onMessage(m: InboundMessage): void {
    // Suspend/resume discipline (Mica, host-sleep ruling): detect and log
    // any clock gap, then reconcile every overdue offer/lease BEFORE
    // processing new grants or speech. The book's expiry receipts carry
    // deadline+overdueMs, so a late expiry is never represented as punctual.
    this.reconcileClock(m.at);
    if (m.surface === 'room') {
      this.lastRoomMessageId = m.messageId;
      this.lastActivityAt = m.at;
      this.lastActivityCause = 'speech';
      this.activitySeq += 1;
      // Head advance reactivates stale-head-suspended bids (§2.2 ruling).
      this.book.noteHead(m.messageId, m.at);
      this.audit(m);
      this.pump();
      return;
    }
    const op = parseOp(m.text);
    if (!op) return; // ordinary chatter in the control thread
    const verb = op.verb === 'unknown' ? (op.unknownVerb ?? '?') : op.verb;
    // The op row keeps the parsed args (ids, readiness, digests) — protocol
    // values. A decline's `reason=` is the one arg that can carry text, and
    // §9 admits only its code: normalized to `stale-head` when that is what
    // was asserted, dropped otherwise (the act is the reason). The row
    // still shows an arg was given, as `cause`.
    const { reason, ...rest } = op.args;
    const args = reason === undefined ? rest : { ...rest, cause: reason === 'stale-head' ? 'stale-head' : 'participant' };
    this.ledger({ kind: 'op', at: m.at, participantId: m.authorId, op: verb, id: op.id, args, raw: m.raw });
    try {
      this.apply(op, m);
    } catch (err) {
      // The refusal must reach the ledger, not only the control band — a
      // failed op whose refusal lives solely in channel scroll makes the
      // ledger claim the op silently vanished (FINDING: epoch 20-47's
      // human accept left no trace of *why* it produced no grant).
      //
      // What reaches the ledger is the CODE (§9 `op-error cause=`): the
      // message is protocol text and goes to the control band, where a
      // human reads it, not into metadata. A refusal without a code is not
      // a participant refusal at all — it is the service failing an
      // invariant — and is ledgered as such rather than dressed as one.
      if (err instanceof FloorRefusal) {
        this.ledger({ kind: 'op-error', at: m.at, participantId: m.authorId, op: verb, id: op.id, cause: err.code });
      } else {
        this.ledger({ kind: 'host-invariant', at: m.at, participantId: m.authorId, op: verb, id: op.id, error: (err as Error).message });
      }
      void this.transport.sendControl(
        eventLine('error', { op: verb, from: m.authorName, cause: err instanceof FloorRefusal ? err.code : 'invariant', detail: (err as Error).message }),
      );
    }
    this.pump();
  }

  private apply(op: FloorOp, m: InboundMessage): void {
    const now = m.at;
    const pid = m.authorId;
    const c = this.book.currentContract!;
    switch (op.verb) {
      case 'unknown':
        throw new FloorRefusal('unknown-op', `unknown op: !floor ${op.unknownVerb ?? '?'}`);
      case 'join': {
        // FINDING-7 (accepted 2026-08-13): a GENUINE join is a logged
        // liveness transition and begins a new quiet epoch — a newcomer
        // must be able to receive a fresh floor/idle; an idle emitted
        // before they existed is not notice to them. Duplicate processing
        // of the same participant's join is idempotent: the notice is
        // re-sent, but it is not a second liveness transition (no repeated
        // wake). Re-arm stays event-driven; no periodic source exists.
        const firstJoin = !this.joined.has(pid);
        this.joined.set(pid, c.contractDigest);
        if (firstJoin) {
          this.lastActivityAt = now;
          this.lastActivityCause = 'participant/joined';
          this.activitySeq += 1;
        }
        void this.transport.sendControl(
          eventLine('joined', {
            participant: m.authorName,
            logic: c.contract.logicId,
            epoch: c.logicEpoch,
            digest: c.contractDigest.slice(0, 12),
            speechLeaseMs: c.contract.knobs.speechLeaseMs,
          }),
        );
        return;
      }
      case 'bid': {
        this.mustBeJoined(pid, c.contractDigest);
        this.bidCounter += 1;
        const expires = op.args.expires ? parseDuration(op.args.expires) : null;
        const bid = this.book.createBid(
          {
            participantId: pid,
            bidId: `b${this.bidCounter}`,
            createdAt: now,
            expiresAt: expires ? now + expires : null,
            readinessKind: (op.args.readiness as never) ?? 'intent',
            subjectRef: op.args.subject,
            payload: op.args.digest ? { digest: op.args.digest } : undefined,
          },
          now,
        );
        void this.transport.sendControl(eventLine('bid/accepted', { bidId: bid.bidId, participant: m.authorName, r: bid.revision }));
        return;
      }
      case 'amend': {
        this.mustOwnBid(pid, this.mustId(op));
        const patch: Record<string, unknown> = {};
        if (op.args.readiness) patch.readinessKind = op.args.readiness;
        if (op.args.subject) patch.subjectRef = op.args.subject;
        if (op.args.digest) patch.payload = { digest: op.args.digest };
        const bid = this.book.amendBid(this.mustId(op), patch, now);
        void this.transport.sendControl(eventLine('bid/amended', { bidId: bid.bidId, r: bid.revision }));
        return;
      }
      case 'cancel':
        this.mustOwnBid(pid, this.mustId(op));
        this.book.cancelBid(this.mustId(op), now, 'participant');
        return;
      case 'accept':
        // A late accept is refused EXPLICITLY (FINDING-8): the book
        // terminates the offer as offer-expired and throws; the refusal
        // goes back on the control band rather than leaving the sender
        // believing it holds a floor the book already reclaimed.
        // Routed through the SERVICE so the refusal charges fairness
        // history like any other offer-expiry (Mica delta review: the
        // host-level book call bypassed noteExpired, letting a late
        // accepter skip its backoff entirely).
        try {
          // Lateness outranks holdership: an accept on YOUR offer that the
          // tick already expired is late, not a stranger's — the same row
          // whether the book or the host notices first.
          if (this.wasMyExpiredOffer(pid, this.mustId(op))) {
            throw new FloorRefusal('late-accept', `late accept refused: offer ${this.mustId(op)} already expired`);
          }
          this.mustHold(pid, this.mustId(op));
          this.service.accept(this.roomId, this.mustId(op), now);
        } catch (err) {
          if (err instanceof FloorRefusal && err.code === 'late-accept') {
            // §9 `accept/refused cause=accept-ttl-elapsed` — the same row in
            // the ledger and on the band.
            this.ledger({ kind: 'accept/refused', at: now, participantId: pid, grantId: this.mustId(op), cause: 'accept-ttl-elapsed' });
            void this.transport.sendControl(
              eventLine('accept/refused', { grantId: this.mustId(op), participant: m.authorName, cause: 'accept-ttl-elapsed' }),
            );
            return;
          }
          throw err;
        }
        return;
      case 'decline': {
        const grantId = this.mustId(op);
        this.mustHold(pid, grantId);
        const blockedHead = this.offerHeads.get(grantId);
        // The band's `reason=` is either the one code a participant may
        // assert (`stale-head`) or the holder's own decline: the act is the
        // reason and any text is dropped here, before the ledger (§9).
        const cause = op.args.reason === 'stale-head' ? 'stale-head' : 'participant';
        this.service.decline(this.roomId, grantId, now, cause, blockedHead);
        // If the room head already moved past the head this offer carried,
        // the suspension's blocking condition is ALREADY gone — reconcile
        // immediately rather than waiting for the next speech.
        if (this.lastRoomMessageId && this.lastRoomMessageId !== blockedHead) {
          this.book.noteHead(this.lastRoomMessageId, now);
        }
        return;
      }
      case 'release':
        this.mustHold(pid, this.mustId(op));
        this.service.release(this.roomId, this.mustId(op), now);
        return;
      case 'continue': {
        this.mustHold(pid, this.mustId(op));
        const ext = op.args.extend ? parseDuration(op.args.extend) : null;
        if (!ext) throw new FloorRefusal('unknown-op', 'continue needs +<duration>, e.g. !floor continue g4 +15s');
        this.book.continueGrant(this.mustId(op), now + ext, now);
        return;
      }
      case 'ack':
        this.book.acknowledged(op.id ?? 'room-head', pid, now);
        return;
      case 'status':
        this.book.restate(now, `status for ${m.authorName}`);
        return;
    }
  }

  /** Voluntary-compliance audit (§1): log, never block. */
  private audit(m: InboundMessage): void {
    if (!this.joined.has(m.authorId)) return; // not a floor participant
    if (this.opts.exemptIds?.includes(m.authorId)) return;
    const holder = this.book.liveGrant;
    if (holder && holder.participantId === m.authorId) return;
    this.violations.push({ at: m.at, participantId: m.authorId, messageId: m.messageId });
    this.ledger({ kind: 'violation', at: m.at, participantId: m.authorId, messageId: m.messageId, raw: m.raw });
    void this.transport.sendControl(
      eventLine('violation', { participant: m.authorName, messageId: m.messageId, holder: holder?.participantId ?? 'none' }),
    );
  }

  // ── the loop ──

  /** Arbitrate + flush: the host's heartbeat, also run after every inbound. */
  pump(): void {
    const now = Date.now();
    this.reconcileClock(now);
    const { grant } = this.service.arbitrate(this.roomId, now);
    this.flush(grant);
    this.checkIdle(now);
  }

  /** Clock-gap witness: a tick that arrives far later than the cadence
   *  promises means the process was suspended (or starved). The gap is
   *  ledgered with the process epoch preserved, and the book reconciles
   *  every overdue deadline in one deterministic pass before any new
   *  arbitration or speech is processed. */
  private lastClockSeen = Date.now();
  private reconcileClock(now: number): void {
    const cadence = this.opts.tickMs ?? 500;
    const gapMs = now - this.lastClockSeen;
    if (gapMs > (this.opts.clockGapThresholdMs ?? Math.max(10_000, cadence * 10))) {
      this.ledger({
        kind: 'clock-gap',
        at: now,
        gapMs,
        expectedCadenceMs: cadence,
        processEpoch: this.book.processEpoch,
      });
      // Close overdue state before anything new — and keep the fairness
      // accounting the service would have applied had the tick been on time.
      const preTick = this.book.liveGrant;
      this.book.tick(now);
      if (preTick && !this.book.liveGrant && this.logic instanceof FluidFairnessLogic) {
        const receipt = this.book.receiptFor(preTick.grantId);
        if (receipt?.terminal === 'offer-expired' || receipt?.terminal === 'lease-expired') {
          this.logic.noteExpired(preTick.participantId, now);
        }
      }
    }
    this.lastClockSeen = now;
  }

  private checkIdle(now: number): void {
    const idleAfter = this.opts.idleAfterMs ?? 60_000;
    // Open-but-ungrantable bids (expiry backoff) do NOT veto idleness: if a
    // grantable bid existed, this pump's arbitrate would have granted it and
    // liveGrant would be set. An idle floor with a stuck book is still idle.
    if (this.book.liveGrant) return;
    if (!this.idleArmed) {
      // Disarmed after emitting: only a liveness transition re-arms, and the
      // cause goes in the ledger. The comparison is sequence, not timestamp —
      // a transition the host processed after the emission re-arms even when
      // its stamp says otherwise (see activitySeq above).
      if (this.activitySeq > this.idleSeenSeq) {
        this.idleArmed = true;
        this.idleRearms.push({ at: now, cause: this.lastActivityCause });
        this.ledger({ kind: 'idle-rearm', at: now, cause: this.lastActivityCause });
      }
      return;
    }
    if (now - Math.max(this.lastActivityAt, this.lastIdleAt) < idleAfter) return;
    this.lastIdleAt = now;
    this.idleSeenSeq = this.activitySeq;
    this.idleArmed = false;
    this.idleEmissions += 1;
    this.ledger({ kind: 'idle', at: now, quietMs: now - this.lastActivityAt });
    void this.transport.sendControl(
      eventLine('floor/idle', { quietMs: now - this.lastActivityAt, holder: 'none' }),
    );
  }

  private flush(offered?: Grant): void {
    for (const e of this.book.eventLog()) {
      if (e.seq <= this.lastSeq) continue;
      this.lastSeq = e.seq;
      // A grant that was offered and then merely expired is a FAILED cycle,
      // not progress — it must not keep resetting the idle clock while an
      // unresponsive bidder churns (otherwise the room can never signal
      // open-floor to standing-ready participants).
      if (e.type !== 'grant/offered' && e.type !== 'grant/offer-expired' && e.type !== 'grant/lease-expired') {
        this.lastActivityAt = e.at;
        this.lastActivityCause = e.type;
        this.activitySeq += 1;
      }
      this.ledger({ kind: 'event', ...e });
      const mention =
        offered && e.type === 'grant/offered' && e.data.grantId === offered.grantId
          ? offered.participantId
          : undefined;
      if (e.type === 'grant/offered') {
        this.offerHeads.set(String((e.data as { grantId: string }).grantId), this.lastRoomMessageId ?? 'none');
      }
      // The stamp exists for exactly one reader — a stale-head decline —
      // and that read happens in apply(), strictly before this flush sees
      // the decline's terminal event. Terminal = the grant can never be
      // read again; an unbounded map of dead grant ids is a slow leak
      // (Mica review, 2026-08-19).
      if (
        e.type === 'grant/declined' ||
        e.type === 'grant/released' ||
        e.type === 'grant/revoked' ||
        e.type === 'grant/offer-expired' ||
        e.type === 'grant/lease-expired'
      ) {
        this.offerHeads.delete(String((e.data as { grantId: string }).grantId));
      }
      void this.transport.sendControl(
        eventLine(e.type, {
          ...e.data,
          ...(e.type === 'grant/offered' ? { head: this.lastRoomMessageId ?? 'none' } : {}),
        }),
        mention,
      );
    }
  }

  // ── internals ──

  /** Standing to bid (§3): a contract acknowledged by joining. Without it
   *  the participant lacks rank in this room — §9's code for that. */
  private mustBeJoined(pid: string, digest: string): void {
    const acked = this.joined.get(pid);
    if (!acked) throw new FloorRefusal('rank', 'join first: bids bind a contract you have acknowledged (§3) — send !floor join');
    if (acked !== digest) throw new FloorRefusal('rank', 'contract changed since you joined — re-join to acknowledge the new terms');
  }

  /** Grant-directed ops (accept, decline, release, continue) are the
   *  HOLDER's. Anyone else naming that grant — or naming a grant that is
   *  not live — is refused `not-holder` (§9), never silently applied to
   *  someone else's turn. */
  private mustHold(pid: string, grantId: string): void {
    const g = this.book.liveGrant;
    if (!g || g.grantId !== grantId || g.participantId !== pid) {
      throw new FloorRefusal('not-holder', `${pid} does not hold live grant ${grantId}`);
    }
  }

  /** An offer that was this participant's and is now terminal offer-expired:
   *  the accept is late (§9 `accept/refused cause=accept-ttl-elapsed`). */
  private wasMyExpiredOffer(pid: string, grantId: string): boolean {
    if (this.book.receiptFor(grantId)?.terminal !== 'offer-expired') return false;
    const offered = this.book.eventLog().find((e) => e.type === 'grant/offered' && e.data.grantId === grantId);
    return offered?.data.participantId === pid;
  }

  /** Bid-directed ops (amend, cancel) are the OWNER's. */
  private mustOwnBid(pid: string, bidId: string): void {
    const b = this.book.listBids().find((x) => x.bidId === bidId);
    if (!b || b.participantId !== pid) {
      throw new FloorRefusal('not-holder', `${pid} does not own bid ${bidId}`);
    }
  }

  private mustId(op: FloorOp): string {
    if (!op.id) throw new FloorRefusal('unknown-op', `${op.verb} needs an id`);
    return op.id;
  }

  private ledger(entry: Record<string, unknown>): void {
    // §9's schema rule at the ledger boundary: a coded field outside the
    // closed set, or a free-text `reason`, cannot be written. Throws —
    // a ledger that would have lied is a ledger that stops.
    assertClosedCodes(entry);
    if (this.opts.ledgerPath) appendFileSync(this.opts.ledgerPath, JSON.stringify(entry) + '\n');
  }
}
