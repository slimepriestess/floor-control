/**
 * Initial logics (FLOOR-RFC-001 §4) — arbitrary declared matchers over the
 * book; these two are the first implementations, not a closed set.
 *
 * A logic never touches book state directly: it reads the open book and
 * returns a decision; the service applies it through the book's guarded
 * operations. That separation is what makes "a bid never self-grants" and
 * "revoke-before-regrant" properties of the system rather than promises of
 * each logic author.
 */

import type { FloorBook } from './book.js';
import type { Bid, IdleProvenance, LogicContract } from './types.js';
import type { HoldCause } from './codes.js';

/** §3 — the lab value, labelled. */
export const LAB_DEFAULT_IDLE: { idleAfterMs: number; idleAfterProvenance: IdleProvenance } = {
  idleAfterMs: 60_000,
  idleAfterProvenance: { kind: 'lab-default', note: 'the trial default, tuned to a standing-ready bot fleet; not a measurement of any room (§3, §12 C1: the social room is "quiet" by it 16.6×/day)' },
};

/** §3 / §12 — the stage-0a calibration receipt's mapping, computed by the
 *  receipt (trial/calibration/calibrate.py on the rfc branch): p90 of the
 *  room's all-pairs gap over the whole measured interval, pooled across
 *  kinds, no trimming, rounded up to the next whole minute. Cited by the
 *  aggregate report's digest as declared in the receipt's manifest. */
const CALIBRATION_RULE = 'p90 of all-pairs message gap over the whole measured interval (2026-08-06..19), pooled across participant kinds, no active-hours trim, rounded up to the next whole minute';
const CALIBRATION_REPORT_SHA256 = 'd8b7540914753163f5e453bea2719b46fc25796b31b8b7cce87062a89dfe2c10';
export const IDLE_CALIBRATION: Record<'social' | 'general', { idleAfterMs: number; idleAfterProvenance: IdleProvenance }> = {
  social: {
    idleAfterMs: 1_440_000, // 24 min (gap p90 23.5 min); floor/idle ≈ 3.8×/day in the interval
    idleAfterProvenance: { kind: 'measured', receipt: 'trial/calibration/MANIFEST.json (rev 10)', reportSha256: CALIBRATION_REPORT_SHA256, rule: CALIBRATION_RULE, room: 'Connectome #worlds' },
  },
  general: {
    idleAfterMs: 8_520_000, // 142 min (gap p90 2.4 h); ≈ 1.1×/day
    idleAfterProvenance: { kind: 'measured', receipt: 'trial/calibration/MANIFEST.json (rev 10)', reportSha256: CALIBRATION_REPORT_SHA256, rule: CALIBRATION_RULE, room: 'Connectome #general' },
  },
};

/** §2.1 / §12 C4 — the measured agent turn, for a contract choosing a
 *  `size` bound: p50 1.2 KB, p90 1.9 KB. A bound is a contract's choice;
 *  none is assumed. */
export const MEASURED_TURN_SIZE = { p50Bytes: 1_200, p90Bytes: 1_900 } as const;

export interface GrantDecision {
  kind: 'grant';
  bidId: string;
  bidRevision: number;
  /** Offer accept-TTL in ms from now; the service computes acceptBy.
   *  (FINDING-8: the offer clock is not the speech clock.) */
  acceptTtlMs: number;
  /** Speech-lease duration applied when acceptance is logged. */
  speechLeaseMs: number;
}

export interface HoldDecision {
  kind: 'hold';
  /** §9 `arbitration/hold` — a code, never prose: the decision is
   *  ledgered wherever a host records decisions. */
  cause: HoldCause;
}

export type LogicDecision = GrantDecision | HoldDecision;

export interface Logic {
  readonly contract: LogicContract;
  /** Called by the service when the book may need a new decision: on bid
   *  changes, grant terminals, and ticks. Pure over (book, now). */
  decide(book: FloorBook, now: number): LogicDecision;
}

/**
 * Fluid fairness — the chairless multi-party ordering for text/eidoverse
 * rooms (§4). One grant at a time from an arrival-informed queue with an
 * anti-starvation rule: among open bids, pick the participant who has held
 * the floor least recently (never-held beats held-longest-ago); ties break
 * by bid arrival order. `urgent` bids jump the queue the way addressing
 * evidence does in voice. Deterministic: no randomness, no clock reads.
 */
export class FluidFairnessLogic implements Logic {
  readonly contract: LogicContract;
  private lastHeld = new Map<string, number>();
  /** Consecutive lease expiries per participant; cleared by any responsive
   *  terminal (release/decline/revoke). Trial FINDING-1: an expired grant
   *  consumed the scarce resource too — it must charge fairness history, and
   *  a repeatedly-unresponsive bidder must not recapture the floor forever. */
  private strikes = new Map<string, number>();
  private lastExpiredAt = new Map<string, number>();
  private readonly speechLeaseMs: number;
  private readonly acceptTtlMs: Record<import('./types.js').ReadinessKind, number>;
  private readonly expiryBackoffMs: number;
  private readonly expiryBackoffCapMs: number;

  constructor(opts?: {
    /** Speech-lease duration, counted FROM ACCEPTANCE (FINDING-8; Mica
     *  2026-08-13: 30s retained, moved to acceptance — 10s rejected, 60s
     *  showed no throughput gain). `leaseMs` is the legacy alias. */
    speechLeaseMs?: number;
    leaseMs?: number;
    /** Offer accept-TTLs per declared readiness kind, set from measured
     *  relay latency with margin (phase-2 sweep: sustained median
     *  offer→accept ≈10s on the portal relay, min ~1.5s). prepared implies
     *  fast; intent gets the median plus margin; manual is a human. */
    acceptTtlMs?: Partial<Record<import('./types.js').ReadinessKind, number>>;
    expiryBackoffMs?: number;
    expiryBackoffCapMs?: number;
    /** §6 burst hold: holder silence before the arbiter releases an
     *  AGENT lease (rev 10: 2.5 s — 0/221 agent-origin handoffs delayed,
     *  77 % of agent continuations coalesced). 0 disables the hold. */
    burstReleaseMs?: number;
    /** A contract MAY narrow the hold to some readiness kinds (e.g.
     *  prepared only); it never widens to humans — kind is structural. */
    burstHoldReadiness?: import('./types.js').ReadinessKind[];
    /** §3 quiet-room liveness: a static contract value WITH its provenance.
     *  Omit both for the labelled lab default; give one without the other
     *  and construction refuses — a number with no stated origin is exactly
     *  the runtime-adaptive knob §3 forbids. */
    idleAfterMs?: number;
    idleAfterProvenance?: IdleProvenance;
    /** §2.1: a bound on the bid envelope's `size` (bytes of prepared
     *  speech), enforced by the book at create/amend. None by default; the
     *  measured turn (MEASURED_TURN_SIZE) is a number to set it from. */
    maxBidSizeBytes?: number;
    knobs?: Record<string, unknown>;
  }) {
    if ((opts?.idleAfterMs === undefined) !== (opts?.idleAfterProvenance === undefined)) {
      throw new Error('idleAfterMs and idleAfterProvenance travel together (§3): a quiet-room value must state where it came from');
    }
    if (opts?.maxBidSizeBytes !== undefined && !(Number.isFinite(opts.maxBidSizeBytes) && opts.maxBidSizeBytes > 0)) {
      throw new Error('maxBidSizeBytes must be a positive finite byte count');
    }
    const idle = opts?.idleAfterMs !== undefined
      ? { idleAfterMs: opts.idleAfterMs, idleAfterProvenance: opts.idleAfterProvenance! }
      : LAB_DEFAULT_IDLE;
    this.speechLeaseMs = opts?.speechLeaseMs ?? opts?.leaseMs ?? 30_000;
    this.acceptTtlMs = {
      prepared: 15_000,
      intent: 20_000,
      urgent: 15_000,
      manual: 60_000,
      ...(opts?.acceptTtlMs ?? {}),
    };
    this.expiryBackoffMs = opts?.expiryBackoffMs ?? this.speechLeaseMs * 2;
    this.expiryBackoffCapMs = opts?.expiryBackoffCapMs ?? this.speechLeaseMs * 8;
    this.contract = {
      logicId: 'fluid-fairness',
      version: 3,
      bidFields: {
        readinessKind: 'intent | prepared | urgent',
        subjectRef: 'optional — what the turn answers',
        ...(opts?.maxBidSizeBytes !== undefined
          ? { size: `bytes of prepared speech (payload.size); bound ${opts.maxBidSizeBytes}` }
          : {}),
      },
      queueVisibility: 'full',
      eventShapes: ['floor:grant', 'floor:hold', 'floor:state', 'floor:idle'],
      api: [],
      knobs: {
        speechLeaseMs: this.speechLeaseMs,
        acceptTtlMs: { ...this.acceptTtlMs },
        lapseAfterIgnoredOffers: 3,
        degradedAfterNoAcceptStreak: 3,
        expiryBackoffMs: this.expiryBackoffMs,
        expiryBackoffCapMs: this.expiryBackoffCapMs,
        burstReleaseMs: opts?.burstReleaseMs ?? 2_500,
        ...(opts?.burstHoldReadiness ? { burstHoldReadiness: opts.burstHoldReadiness } : {}),
        idleAfterMs: idle.idleAfterMs,
        idleAfterProvenance: idle.idleAfterProvenance,
        ...(opts?.maxBidSizeBytes !== undefined ? { maxBidSizeBytes: opts.maxBidSizeBytes } : {}),
        ...(opts?.knobs ?? {}),
      },
      moderation: [],
    };
  }

  noteTerminal(participantId: string, at: number): void {
    this.lastHeld.set(participantId, at);
    this.strikes.delete(participantId); // a responsive terminal clears strikes
  }

  /** A stale-head decline is responsive (strikes clear) but the decliner
   *  never held the floor — stamping lastHeld would rotate them to the
   *  back as if they had spoken, which is exactly the fairness punishment
   *  the §2.2 ruling forbids for a correct refusal. */
  noteResponsiveDecline(participantId: string): void {
    this.strikes.delete(participantId);
  }

  /** An expired lease charges held-history AND accrues a strike: backoff
   *  doubles per consecutive expiry, bounded by expiryBackoffCapMs. */
  noteExpired(participantId: string, at: number): void {
    this.lastHeld.set(participantId, at);
    this.strikes.set(participantId, (this.strikes.get(participantId) ?? 0) + 1);
    this.lastExpiredAt.set(participantId, at);
  }

  private eligible(participantId: string, now: number): boolean {
    const s = this.strikes.get(participantId);
    if (!s) return true;
    const backoff = Math.min(this.expiryBackoffCapMs, this.expiryBackoffMs * 2 ** (s - 1));
    return now >= (this.lastExpiredAt.get(participantId) ?? 0) + backoff;
  }

  decide(book: FloorBook, now: number): LogicDecision {
    if (book.liveGrant) return { kind: 'hold', cause: 'floor-occupied' };
    const open = book.openBids();
    if (open.length === 0) return { kind: 'hold', cause: 'no-open-bids' };
    // Expiry backoff DOWNRANKS (antra 2026-08-11: "downrank them for the
    // next few rounds"): in any contested round a struck bidder loses to
    // every eligible competitor. When even the round's best bid is in
    // backoff (a solo unresponsive bidder), the round HOLDS for the bounded
    // cooldown instead of granting — immediate regrant would churn
    // grant/expire cycles at a non-responder and keep the floor nominally
    // occupied, suppressing the open-floor idle signal standing-ready
    // participants depend on.
    const pick = (candidates: Bid[]): Bid =>
      candidates.slice().sort((a, b) => {
        const ea = this.eligible(a.participantId, now) ? 0 : 1;
        const eb = this.eligible(b.participantId, now) ? 0 : 1;
        if (ea !== eb) return ea - eb; // eligible before backed-off
        const ha = this.lastHeld.get(a.participantId) ?? -1;
        const hb = this.lastHeld.get(b.participantId) ?? -1;
        if (ha !== hb) return ha - hb; // least-recently-held first; never-held (-1) wins
        return a.createdAt - b.createdAt; // then arrival order
      })[0];
    const urgent = open.filter((b) => b.readinessKind === 'urgent');
    const chosen = urgent.length > 0 ? pick(urgent) : pick(open);
    if (!this.eligible(chosen.participantId, now)) {
      return { kind: 'hold', cause: 'cooldown' };
    }
    return {
      kind: 'grant',
      bidId: chosen.bidId,
      bidRevision: chosen.revision,
      acceptTtlMs: this.acceptTtlMs[chosen.readinessKind],
      speechLeaseMs: this.speechLeaseMs,
    };
  }
}

/**
 * Chaired (Session 1) — the book informs, the chair decides (§4, §8). The
 * logic itself always holds; grants happen only through the chair API the
 * contract announces (service.chairGrant). ✋ is a `manual` bid; restate,
 * withdraw, and the one-sentence substitute ride the book's own verbs.
 */
export class ChairedLogic implements Logic {
  readonly contract: LogicContract;

  constructor(chairId: string, knobs?: Record<string, unknown>) {
    this.contract = {
      logicId: 'chaired-session1',
      version: 1,
      bidFields: { readinessKind: 'manual (✋)', subjectRef: 'optional — agenda item' },
      queueVisibility: 'full',
      eventShapes: ['floor:grant', 'floor:state'],
      api: ['chair/grant', 'chair/revoke', 'chair/restate'],
      knobs: {
        chairId,
        debounceMs: 15_000,
        turnCap: 'two paragraphs, dense if needed',
        exemptions: ['humans speak freely without hands'],
        ...(knobs ?? {}),
      },
      moderation: [],
    };
  }

  decide(): LogicDecision {
    return { kind: 'hold', cause: 'chair-discretion' };
  }
}
