/**
 * The floor service (FLOOR-RFC-001 §5–§7): room registry with binding
 * claims, logic wiring, and the chair API surface. Transport adapters
 * (WS/HTTP, MCPL, Portal, eidoverse) sit above this; none exist in the
 * skeleton — this is the core the conformance suite exercises.
 */

import { FloorBook } from './book.js';
import { FluidFairnessLogic, type Logic, type LogicDecision } from './logics.js';
import type { Bid, BindingClaim, BurstHold, Grant, ParticipantKind, Receipt } from './types.js';
import { FloorRefusal, type DeclineCause } from './codes.js';

export interface Room {
  roomId: string;
  book: FloorBook;
  logic: Logic;
  bindings: BindingClaim[];
  /** §6 burst hold on the live grant, or null. Arbiter-owned: only
   *  noteSpeech creates it and only settleBurst / a terminal ends it. */
  burst: BurstHold | null;
}

/** A delivered room-speech record as the transport reports it (§6): who,
 *  by identity class, when, and whether the transport delivered it. */
export interface SpeechRecord {
  participantId: string;
  kind: ParticipantKind;
  at: number;
  /** Default true. A send the transport reports as failed extends nothing. */
  delivered?: boolean;
}

export class FloorService {
  readonly processEpoch: string;
  private rooms = new Map<string, Room>();
  private roomCounter = 0;

  constructor(processEpoch: string) {
    this.processEpoch = processEpoch;
  }

  // ── Rooms & bindings (§5) ──

  /** Register a room with its first authenticated binding claim. The claim
   *  makes the binding addressable; it never auto-merges with any other
   *  binding — merging is `declareSharedBinding`, an explicit act. */
  registerRoom(locator: string, provenance: string, logic: Logic, now: number): Room {
    this.roomCounter += 1;
    const roomId = `room#${this.roomCounter}`;
    const book = new FloorBook(roomId, this.processEpoch);
    const room: Room = {
      roomId,
      book,
      logic,
      bindings: [{ locator, provenance, claimedAt: now, provisional: true }],
      burst: null,
    };
    this.rooms.set(roomId, room);
    book.activateContract(logic.contract, now);
    return room;
  }

  /** A transport presenting the same authenticated provenance for an
   *  already-claimed locator deterministically lands on the same room. A
   *  DIFFERENT locator never merges implicitly, even with equal names. */
  claimBinding(roomId: string, locator: string, provenance: string, now: number): BindingClaim {
    const room = this.mustRoom(roomId);
    const existing = room.bindings.find((b) => b.locator === locator);
    if (existing) {
      if (existing.provenance !== provenance) {
        throw new Error(`binding ${locator} already claimed with different provenance`);
      }
      existing.provisional = false;
      return existing;
    }
    const claim: BindingClaim = { locator, provenance, claimedAt: now, provisional: true };
    room.bindings.push(claim);
    return claim;
  }

  /** Explicit multi-binding declaration (§9): sameness is declared, never
   *  inferred. One live grant then excludes holders across ALL bindings —
   *  which is automatic, because bindings share one book. */
  declareSharedBinding(roomId: string, locator: string, provenance: string, now: number): BindingClaim {
    return this.claimBinding(roomId, locator, provenance, now);
  }

  findRoomByBinding(locator: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.bindings.some((b) => b.locator === locator)) return room;
    }
    return undefined;
  }

  // ── The arbitration loop ──

  /** Ask the room's logic for a decision and apply it through the book's
   *  guarded ops. Returns the applied decision. This is the ONLY path from
   *  logic to grant — bids cannot self-grant. */
  arbitrate(roomId: string, now: number): { decision: LogicDecision; grant?: Grant } {
    const room = this.mustRoom(roomId);
    const preTick = room.book.liveGrant;
    room.book.tick(now);
    // An expiry under the tick consumed the floor too: charge the holder's
    // fairness history and strike count (FINDING-1 — without this, the
    // reopened bid stays "never held" and recaptures the floor forever).
    // Both expiry terminals count: an ignored offer and an overrun lease
    // each wasted the scarce resource (FINDING-8 split the clocks, not the
    // accountability).
    if (preTick && !room.book.liveGrant) {
      const receipt = room.book.receiptFor(preTick.grantId);
      if ((receipt?.terminal === 'offer-expired' || receipt?.terminal === 'lease-expired')
          && room.logic instanceof FluidFairnessLogic) {
        room.logic.noteExpired(preTick.participantId, now);
      }
    }
    // §6: after the book's own clocks (a lease expiry at the ceiling wins),
    // settle the burst hold — a release here precedes the decision below,
    // so the next bidder is offered only after the terminal.
    this.settleBurst(room, now);
    const decision = room.logic.decide(room.book, now);
    if (decision.kind === 'grant') {
      const grant = room.book.offerGrant(
        decision.bidId,
        decision.bidRevision,
        { acceptBy: now + decision.acceptTtlMs, speechLeaseMs: decision.speechLeaseMs },
        now,
      );
      return { decision, grant };
    }
    return { decision };
  }

  /** Terminal bookkeeping shared by all release paths: forwards fairness
   *  history to logics that track it. */
  private noteTerminal(room: Room, grant: Grant, at: number): void {
    if (room.logic instanceof FluidFairnessLogic) {
      room.logic.noteTerminal(grant.participantId, at);
    }
  }

  release(roomId: string, grantId: string, now: number, boundary?: Receipt['boundary']): Receipt {
    const room = this.mustRoom(roomId);
    const grant = room.book.liveGrant;
    const receipt = room.book.releaseGrant(grantId, now, boundary);
    if (room.burst?.grantId === grantId) room.burst = null; // an explicit release releases NOW
    if (grant) this.noteTerminal(room, grant, now);
    return receipt;
  }

  // ── §6 emission coalescing: the burst hold ──

  /** A delivered room-speech record on this room's binding. If it is the
   *  ACCEPTED holder's own speech, and the holder is agent-class, the hold
   *  is (re)armed: releaseAt = min(at + burstReleaseMs, leaseUntil). Every
   *  other case — another speaker, an offered-but-unaccepted grant, a
   *  human holder, a failed send, a contract without a hold, a readiness
   *  kind the contract excludes — leaves the hold exactly as it was.
   *  Returns the hold in force after this record, or null. */
  noteSpeech(roomId: string, rec: SpeechRecord): BurstHold | null {
    const room = this.mustRoom(roomId);
    const g = room.book.liveGrant;
    if (!g || g.state !== 'accepted') return room.burst;
    if (rec.delivered === false) return room.burst;
    if (g.participantId !== rec.participantId) return room.burst;
    if (rec.kind !== 'agent') return room.burst;
    const knobs = room.book.currentContract?.contract.knobs ?? {};
    const burstMs = Number(knobs.burstReleaseMs ?? 0);
    if (!(burstMs > 0)) return room.burst;
    const narrow = knobs.burstHoldReadiness;
    if (Array.isArray(narrow)) {
      const bid = room.book.listBids().find((b) => b.bidId === g.bidId);
      if (bid && !narrow.includes(bid.readinessKind)) return room.burst;
    }
    room.burst = {
      grantId: g.grantId,
      generation: this.generationOf(room),
      lastSpeechAt: rec.at,
      releaseAt: Math.min(rec.at + burstMs, g.leaseUntil),
    };
    return room.burst;
  }

  /** The hold currently in force, if any — read-only. */
  burstHold(roomId: string): BurstHold | null {
    return this.mustRoom(roomId).burst;
  }

  private generationOf(room: Room): string {
    return `${room.book.processEpoch}#${room.book.currentContract?.logicEpoch ?? 0}`;
  }

  /** Called from arbitrate after the book's own clocks. A hold whose grant
   *  is gone, no longer accepted, or from another generation is dropped
   *  without effect; a hold whose releaseAt has passed releases the grant
   *  on the holder's behalf — the same `released` terminal an explicit
   *  release produces (§6: the two carriers converge on one receipt). */
  private settleBurst(room: Room, now: number): void {
    const h = room.burst;
    if (!h) return;
    const g = room.book.liveGrant;
    if (!g || g.grantId !== h.grantId || g.state !== 'accepted' || this.generationOf(room) !== h.generation) {
      room.burst = null;
      return;
    }
    if (now >= h.releaseAt) {
      room.burst = null;
      this.release(room.roomId, g.grantId, now);
    }
  }

  /** Acceptance through the service, so terminal bookkeeping has one owner
   *  (Mica delta review 2026-08-13). A timely accept starts the speech
   *  lease. A LATE accept is refused explicitly by the book — and charges
   *  the same fairness history/strike as any other offer-expiry, exactly
   *  once: without this, the late/jitter path from FINDING-8 would bypass
   *  FINDING-1's repair and the refused bidder could be re-granted one
   *  arbitration later. The following pump cannot double-charge — by the
   *  time it runs, the grant is already terminal, so arbitrate's
   *  offered→expired observation never fires for it. */
  accept(roomId: string, grantId: string, now: number): Grant {
    const room = this.mustRoom(roomId);
    const holder = room.book.liveGrant;
    try {
      return room.book.acceptGrant(grantId, now);
    } catch (err) {
      if (
        holder &&
        holder.grantId === grantId &&
        err instanceof FloorRefusal && err.code === 'late-accept' &&
        room.book.receiptFor(grantId)?.terminal === 'offer-expired' &&
        room.logic instanceof FluidFairnessLogic
      ) {
        room.logic.noteExpired(holder.participantId, now);
      }
      throw err;
    }
  }

  decline(roomId: string, grantId: string, now: number, cause: DeclineCause = 'participant', blockedHead?: string): Receipt {
    const room = this.mustRoom(roomId);
    const grant = room.book.liveGrant;
    const receipt = room.book.declineGrant(grantId, now, cause, blockedHead);
    if (room.burst?.grantId === grantId) room.burst = null;
    if (grant) {
      if (cause === 'stale-head' && room.logic instanceof FluidFairnessLogic) {
        // §2.2 ruling: fairness MUST NOT punish a correct stale-head
        // refusal. Responsive (strikes clear) — but the decliner never
        // held the floor, so no held-history stamp.
        room.logic.noteResponsiveDecline(grant.participantId);
      } else {
        this.noteTerminal(room, grant, now);
      }
    }
    return receipt;
  }

  // ── Chair API (§3: API-driven chairs; §4 chaired logic) ──

  /** Manual grant through the contract's announced API. Authorized against
   *  the active contract's chairId knob; the book's invariants (one live
   *  grant, exact revision, positive expiry) apply unchanged — a chair is
   *  powerful, not exempt. */
  chairGrant(
    roomId: string,
    actorId: string,
    bidId: string,
    bidRevision: number,
    timing: { acceptTtlMs: number; speechLeaseMs: number },
    now: number,
  ): Grant {
    const room = this.mustRoom(roomId);
    this.mustBeChair(room, actorId);
    return room.book.offerGrant(
      bidId,
      bidRevision,
      { acceptBy: now + timing.acceptTtlMs, speechLeaseMs: timing.speechLeaseMs },
      now,
    );
  }

  /** The chair revokes. No operator string rides the receipt (§9): the
   *  cause is `chair`, the actor is its own field, and the chair's
   *  explanation — if any — is room traffic. */
  chairRevoke(roomId: string, actorId: string, grantId: string, now: number): Receipt {
    const room = this.mustRoom(roomId);
    this.mustBeChair(room, actorId);
    const grant = room.book.liveGrant;
    const receipt = room.book.revokeGrant(grantId, now, 'chair', actorId);
    if (room.burst?.grantId === grantId) room.burst = null;
    if (grant) this.noteTerminal(room, grant, now);
    return receipt;
  }

  chairRestate(roomId: string, actorId: string, now: number, note?: string): void {
    const room = this.mustRoom(roomId);
    this.mustBeChair(room, actorId);
    room.book.restate(now, note);
  }

  // ── Restart (§2.3 epoch death) ──

  /** Rebuild the service in a new process epoch from persisted rooms.
   *  Grants are never restored; durable bids come back 'stale'. */
  static restore(
    newProcessEpoch: string,
    persisted: Array<{ roomId: string; bindings: BindingClaim[]; logic: Logic; durableBids: Bid[] }>,
    now: number,
  ): FloorService {
    const svc = new FloorService(newProcessEpoch);
    for (const p of persisted) {
      const book = FloorBook.restore(p.roomId, newProcessEpoch, p.durableBids, now);
      book.activateContract(p.logic.contract, now);
      // Epoch death (§2.3): no hold survives a restart.
      svc.rooms.set(p.roomId, { roomId: p.roomId, book, logic: p.logic, bindings: p.bindings, burst: null });
      const n = Number(p.roomId.split('#')[1]);
      if (Number.isFinite(n)) svc.roomCounter = Math.max(svc.roomCounter, n);
    }
    return svc;
  }

  room(roomId: string): Room {
    return this.mustRoom(roomId);
  }

  private mustRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);
    return room;
  }

  private mustBeChair(room: Room, actorId: string): void {
    const chairId = room.book.currentContract?.contract.knobs.chairId;
    if (chairId !== actorId) {
      throw new FloorRefusal('rank', `actor ${actorId} is not this room's chair (contract names ${String(chairId)})`);
    }
  }
}
