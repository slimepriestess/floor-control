# FLOOR-RFC-001 — The floor protocol: an order book for speaking turns

- **Status:** Draft rev 10 — answers Mica's rev-9 review (2026-09-11,
  six blockers): the stage-0a calibration now has a reproducible receipt
  (`trial/calibration/`, §12) and the numbers it corrected are corrected
  in place; §9's reason set is enumerated and closed; §3's `idleAfterMs`
  is a deterministic per-room mapping from the receipt; §6's
  `burstReleaseMs` has one lifecycle owner and conformance vectors; C3
  claims only what timestamp/author/bytes data can show; and stage 0b's
  counterfactual lifecycle is normative and matches the instrument branch.
  Second pass (same day, after Mica's re-review): the receipt is
  aggregate-only (records stay local), §6's burst cost uses the
  agent-origin denominator, and §9 closes the 0b classes and the
  exactly-once terminal. Rev 9 added the stage-0a calibration block: the
  rhythm-observation backscroll harvest (2026-08-19) measured real-room
  rhythm against the trial rig's assumptions, and one published finding
  was corrected against it (2026-08-25, §12 calibration); also folds
  Mica's rev-8.1 nonblocking carry (§9: hold/decline reasons are
  closed/bounded protocol values). Rev 8.1 (APPROVED by Mica
  2026-08-28 at `2cb0637`) closed the two rev-8 artifact-review seams:
  reaffirmation named as a wire act (§2.2), and stage 0 split into
  rhythm observation vs. counterfactual shadow with
  identifier-handling a disclosure obligation in its own right. Rev 8
  was: trial-hardened, human-contact tested, interaction-model settled;
  observation window closed 2026-08-19.
  Founding RFC for `anima-research/floor-control`; revised against ten
  findings from the live multi-agent trial (2026-08-11 → 08-14) and
  Mica's rulings on them (2026-08-13/14), then reconfirmed by the
  phase-3 run on merged main (2026-08-17, §12) — the first live outing
  where all ten findings' machinery ran together — plus findings 11–15
  from phase 4's human-contact day (2026-08-18) — the run that answered
  the two-band-split question the trial was sent to ask, settled the
  human and agent interaction models (§6), and earned the stale-head
  suspension rule (§2.2). Findings ledger
  in §12; every claim there has a raw ledger or deterministic scenario
  behind it in `trial/`.
- **Authors:** Ra & Weft (Claude). Core model by antra (2026-08-06, the
  order-book formulation); protocol freeze, identity/registry design, and
  cautions by Sol; precedent curation by Sol; trial review and phase-3
  rulings by Mica.
- **Date:** 2026-08-06 · rev 5: 2026-08-14 · rev 6: 2026-08-18 · rev 7: 2026-08-18 · rev 8: 2026-08-19 · rev 8.1: 2026-08-28 · rev 9: 2026-08-28 · rev 10: 2026-09-11
- **Decision record:** four frames in two days, kept so founding main
  encodes none of the stale ones: *manual-as-definition* (8/5, Sol's lean)
  → *automated-as-definition* (8/6 AM, antra: fluid rooms must not be
  manual-gated) → *protocol/strategy separation* (8/6, antra via Sol) →
  **final: the order-book model** (8/6, antra; Sol: "the first formulation
  that makes the whole object clear… better than the traffic-light
  analogy"). Floor control observes the room, accepts managed bids, runs a
  declared matching logic, and emits grants/events; participants
  voluntarily bind their speech behavior to those grants.
- **Precedent:** Governance Session 1 minutes, committed beside this RFC
  (`governance-session-1-minutes.md`, 30,294 bytes). Per Sol's ruling:
  meeting precedent, not blanket floor specification — only the adopted
  practice block (D1) and directly relevant floor examples are normative.
- **Consumers (initial):** Discord voice rooms via Portal (PORTAL-RFC-006
  rev 3 transport contract + the new Portal voice-output path); fluid
  multi-party text rooms — eidoverse rooms are the named live target;
  structured text meetings (the chaired logic).
- **Explicitly not:** a Portal feature (transport only), a Host module
  (floor arbitration is cross-resident and cross-medium), or an MCPL SPEC
  primitive (an MCPL *adapter* exists; the core must not depend on MCPL's
  chat-channel representation, and room/turn policy does not enter SPEC
  unless independent implementations someday need wire interop).

---

## 1. The model

A room has traffic. Traffic is consumed asynchronously by participants —
and by floor control, which is a *consumer of the room, not a gate in
front of it*. Participants place, amend, and cancel **bids** to speak,
like orders on an electronic market. A room's active **logic** — a
pluggable matcher/controller over the bid book — decides grants. The
protocol below is the stable substrate every logic runs on; fairness,
chairing, storytelling, targeting, and timing all live in logics, not
here.

Three properties define the system's character:

- **Voluntary compliance.** The floor service does not physically gate any
  channel. The protocol promises *auditable grants and compliant
  non-overlap* — it cannot promise a broken or malicious participant never
  speaks out of turn. Transport adapters MAY enforce grants on their own
  paths (e.g. Portal refusing TTS/audio injection without a valid grant);
  moderation is a separate, explicitly granted capability (§7).
- **Grants need not cause inference.** A participant may hold a prepared
  response and emit it on grant — genuine zero-inference losers,
  near-zero-latency winners (§4, `readinessKind`).
- **Two communication bands, no hidden text path** (antra + Sol): the
  service emits **structured control-plane events** (bid/grant lifecycle,
  `contract/changed`, state snapshots — machine-readable, wake-gate
  drivable); all **human-readable speech** — chair remarks, DM narration,
  plain-language notices — travels as ordinary messages in the normal
  room/channel under the speaker's visible identity and normal provenance.
  There is no `floor/announce` content operation.

## 2. Frozen base protocol (layer 1)

### 2.1 Bid envelope

A logic defines its bid *payload*; the envelope is stable:

```
roomId, logicEpoch, contractDigest, participantId, bidId, revision,
createdAt, expiresAt, subjectRef/inReplyTo, readinessKind
```

`readinessKind` distinguishes at least: `intent` (would speak) ·
`prepared` (content ready locally) · `manual` (human/chair-initiated
request) · `urgent` (interruption class).

**Prepared speech stays with its author.** The participant retains
plaintext; the bid carries digest/size/readiness token. The envelope
defines the `size` field but no bound on it; the measured agent turn is
p50 1.2 KB / p90 1.9 KB (§12 C4), so a contract that wants a bound has a
number to set — declaring one is a rev-10 item, not an assumption this
section makes. On grant, the
participant verifies the room head/subject is still valid, then emits — if
stale, it declines or rebids. The floor service is not a warehouse of
unsent speech unless a room's contract explicitly requires semantic bid
content (and says so, §5).

### 2.2 Operations

```
bid/create · bid/amend · bid/cancel · bid/list · bid/status
grant                — references the exact bid revision it answers
grant/accept | decline
grant/continue | release
grant/revoke
offer-expire | lease-expire   — two clocks, two terminals (§2.4)
bid/lapsed           — terminal after ignored offers (§2.5); not an op
state snapshot + append-only event/receipt stream
```

**One open bid per participant** (FINDING-3; ruling by Mica 2026-08-11):
a speaking floor is not a depth market — one identity cannot hold two
concurrent turns-in-waiting. `bid/create` while a bid is open REPLACES it
under the stable `bidId` (revision bump, `bid/replaced` in the ledger),
and the replacement PRESERVES the original `createdAt`: editing a pending
turn does not send its author to the back of the queue, and revision
churn cannot parlay that age into stale authority because a grant binds
the exact revision it answers. A granted bid cannot be replaced or
amended at all.

**Stale-head declines suspend the bid revision** (FINDING-14 family;
ruling by Mica 2026-08-18): a `grant/declined reason=stale-head` removes
that exact bid revision from ordinary arbitration — re-offering the same
`(bidId, revision)` against the same head is provably futile, and the
trial measured what happens without this rule: an engaged, polite,
permanently-stale bidder churned offer/decline every six seconds,
invisible to lapse (declines are engagement), to degradation telemetry,
and to fairness. The service emits one durable `bid/suspended
cause=stale-head blockedHead=…`; eligibility returns on **either** an
authoritative head advance **or** a participant-authored reaffirmation.
Reaffirmation is not a new operation (rev 8.1, closing a review seam —
the act was previously prose-only): it is **`bid/amend` on the
suspended bid** — wire form `!floor amend <bidId> [fields…]`, where an
amend carrying no field changes is a pure reaffirmation — or
equivalently a `bid/create` replacement by the same participant, which
reaches the same path through the one-bid rule above. Either act bumps
the revision, returns the bid to `open`, and emits `bid/reactivated
cause=reaffirmation`. The NEW revision is what re-enters arbitration;
no head is pinned on the bid — the author reaffirms with the current
head in view (it is the room's banner), and futility is re-judged at
the next offer against whatever head holds then, while the suspended
`(bidId, revision, blockedHead)` tuple itself stays permanently
un-offerable. The reaffirmation
path exists because head-staleness is not meaning-staleness (§6): an
agent whose point survives an intervening message says so explicitly and
cheaply, rather than being machine-classified as stale. Original queue
age is preserved; fairness MUST NOT punish a correct stale-head refusal.
A second offer of the same `(bidId, revision, blockedHead)` tuple is a
service invariant failure and emits a distinct degradation/error
receipt. Long-lived suspensions get age/count telemetry — never churn.

Structured events include `contract/changed {logicEpoch, contractDigest,
…}`, bid accepted/cancelled, grant lifecycle, and floor-state snapshots.
A contract change invalidates/renegotiates affected bids and grants per
§5, and MAY be accompanied by a plain-language notice posted through the
normal channel adapter — as room traffic, not as a protocol operation.

### 2.3 Grant binding and lifecycle invariants

Every grant binds exact **`logicEpoch + contractDigest + bidRevision +
roomId + participantId`** and carries positive, finite deadlines. Named
conformance tests:

- **Grant-before-cost** (for contract-honoring participants): no wake, no
  provider inference, no synthesis/audio open, no floor turn without a
  live grant naming the holder. Losing/waiting bidders spend zero.
- **Positive expiry on both clocks** (§2.4); extension = `grant/continue`,
  never silence.
- **Revoke-before-regrant** — one live grant per room, including handoffs.
- **Epoch death:** active grants die on floor-service process-epoch
  change and on logic swap (new `logicEpoch`). Durable bids MAY survive
  restart but MUST be revalidated; **zombie speaking authority may not.**
- **Idempotent terminal receipts** — `completed | released | revoked |
  offer-expired | lease-expired | declined`, deduped by grant id, safe to
  re-send, carrying medium-reported boundaries (e.g. voiced/unvoiced)
  when a turn was cut.
- **One accounting owner.** Every terminal transition — however reached:
  tick, late accept, suspend/resume reconciliation — passes through one
  owner that applies fairness/history bookkeeping exactly once. A second
  entry point silently forks the accounting (the trial's delta-review
  blocker: a host-level late-accept path bypassed the expiry charge, and
  the refused bidder was re-grantable one arbitration later).

### 2.4 Two clocks (FINDING-8; ruling by Mica 2026-08-13)

The single offer-anchored lease produced both failure modes the trial
measured: an unresponsive bidder burned a full speech lease per cycle
(session A: one such participant collapsed room throughput ~7×), and one
relay-jitter spike expired a grant its holder had accepted in good faith,
branding honest speech a violation (run B). One split resolves both:

1. **Offer accept-TTL** — begins when the offer is issued. Set per
   declared `readinessKind` from measured transport latency with margin
   (never one guessed universal value): `prepared`/`urgent` imply fast,
   `intent` gets the sustained median plus margin, `manual` is a human.
2. **Speech lease** — begins only when acceptance is authoritatively
   logged. A timely accept receives the FULL lease regardless of
   pre-accept relay delay. An unanswered offer consumes only its
   accept-TTL, never a speech lease.

A late accept is refused explicitly — the sender must never be left
believing it holds a floor the book already reclaimed. Terminals stay
separate: `offer-expired` (never accepted) vs `lease-expired` (accepted,
then failed to finish/release). Both charge fairness history — the clocks
split, the accountability does not. Lease sizing is evidence-bound
(§4, sweep): keep speech leases generous; discipline the unresponsive
with accept-TTL and lapse, never with short leases, which cannot reach
the unresponsive and only punish the responsive on jitter.

### 2.5 Bid lapse and degradation telemetry (FINDINGS 9–10; rulings 2026-08-13)

Durable bids survive expiry by design — but nothing retired one whose
owner stopped listening: the trial's run B granted two such bids **230
times over three hours**, throttled only by backoff, invisible to any
operator, while the room simultaneously (and truthfully) reported idle.

- **`bid/lapsed`** — terminal, after **three consecutive offer expiries
  without acceptance** for the same open bid. Declining is responsive and
  never counts; acceptance clears the streak; a lapsed bid receives no
  further grants; re-entry requires an explicit fresh bid. The lapse
  event records cause, `bidId`, revision, expiry count, and time — and
  claims nothing about why the owner did not answer.
- **Degradation telemetry, not control** — two streaks: per-bid ignored
  offers, and room-wide consecutive offer expiries with no intervening
  acceptance. At three room-wide, emit ONE operator-visible
  `book/degraded`; the next acceptance emits `book/recovered` and resets.
  The signal never alters fairness, blocks bids, or falsifies
  `floor/idle` — an idle floor with an unresponsive book is still idle,
  and the degradation event explains the difference rather than
  redefining it.

### 2.6 Truthful time (host-sleep ruling, 2026-08-13)

An arbiter's process can be suspended (the trial's session A froze
fifteen minutes under macOS App Nap). The protocol's answer is honesty,
not prevention: detect and log the clock gap (with process identity);
reconcile every overdue offer and lease before processing any new grant
or speech; and carry `deadline` + `overdueMs` on late expiry receipts —
**a late expiry is never represented as punctual.** Deployments run the
arbiter on a non-sleeping host; the reconciliation discipline exists for
the day that fails.

That day arrived on schedule: the phase-3 arbiter, left running overnight
on a laptop (2026-08-17→18), slept in bursts despite `caffeinate -i`
(which does not block lid-sleep). The ledger shows 32 witnessed clock
gaps totaling ~416 minutes (longest single gap 17.4 min), each recorded
against the expected cadence, with zero arbitration performed inside a
gap and zero events misrepresented as punctual. Overnight quiescence is
therefore evidence of *truthful* quiescence, not of long-run stability
under load — the distinction the gap records exist to make legible.

## 3. Logic contracts (§the policy boundary)

The announced contract is a real policy boundary (Sol): versioned and
digested; **acknowledged by a participant before its bids/grants bind
it**; declaring required bid fields, queue visibility, bid-content privacy
(what enters the visible book vs. stays logic-private), fairness/priority
rules, wake-event shapes, moderation authority, expiry defaults, and cost
behavior. A logic swap creates a new `logicEpoch` and invalidates old
grants.

**Wake signals are optional logic output.** A logic can emit wake shapes
(stable `floor:*` tags on the MCPL adapter, §6) to save losing
participants their inference; participants configure their own gates —
the service does not own anyone's attention.

**Quiet-room liveness** (FINDINGS 2 + 7; rulings by Mica). A room host MAY
emit a one-shot `floor/idle` after a quiet lease with a free floor —
standing-ready participants treat it as a bid opportunity, so liveness
never depends on an unlogged human nudge. The quiet lease is
rhythm-calibrated, not universal: the trial's 60 s default is tuned to a
standing-ready bot fleet, and the measured social room is "quiet" by that
definition 16.6 times a day (§12 C1). **`idleAfterMs` is a static
contract value with a stated provenance, never a runtime-adaptive one**:
it lives in the versioned, digested logic contract, so recomputing it at
runtime would change the digest under live grants — a re-calibration is
a contract revision (new `logicEpoch`), as any knob change is. Its
provenance is a completed stage-0a measurement of the room's own binding,
cited by the receipt's manifest digest (§12). **The mapping is
deterministic and is computed by the receipt, not by hand** (rev 10,
closing Mica's blocker 3; rev 9 had written the two rooms' p90s as one
number): `idleAfterMs` = the p90 of the room's all-pairs gap distribution
over the whole measured interval — pooled across participant kinds,
because room silence is a property of the room, not of a kind (the C3
split rule governs knobs about a *kind's* behaviour; this is not one) —
with no active-hours or overnight trimming (the p90 already discards the
long tail; a trimmed variant is a *different contract value*, declared as
such, not a hidden parameter), rounded up to the next whole minute.
Measured: social room gap p90 23.5 min → **24 min** (`floor/idle` would
have fired 3.8×/day in the measured interval, against 16.6×/day at 60 s);
#general gap p90 2.4 h → **142 min** (1.1×/day, against 5.8). Both rows,
and the firing rates that let a reader judge them, are in
`trial/calibration/REPORT.md` (§3 derivation). A room with no completed
measurement keeps `floor/idle` lab-only. The one-shot fires once per
quiet epoch and disarms; **re-arm is event-driven only** — a logged
liveness transition, never a timer (the liveness primitive must not
become a periodic wake source). **A genuine participant join is a logged
liveness transition and begins a new quiet epoch**: an idle event emitted
before a participant existed cannot count as notice to them, and the
participant who most needs the open-floor signal is exactly the one who
arrived after it fired. Duplicate processing of one join re-sends the
notice but is never a second wake.

**API-driven chairs.** A contract may expose an API through which a
participant regulates the process — manual chairing is an API-driven
logic, not a special architecture. Chair/delegation surfaces are
explicit, attributed, revocable, never inherited.

**Dual-role caution (Sol):** a generative storyteller/DM logic may have
floor-exempt control output by contract, but when it speaks *creatively as
a character* that output is typed/accounted distinctly — arbiter power
must not become hidden participant privilege.

## 4. Initial logics (layer 2 — arbitrary declared matchers; these are
the first implementations, not a closed set)

- **Fluid fairness (text / eidoverse — the named live target; contract
  v3):** chairless multi-party ordering; one grant at a time from a
  visible, arrival-informed, fairness-aware book (no starvation, no
  double-holding); addressing evidence jumps the queue. Expiry charges
  held-history and accrues a strike (FINDING-1): in contested rounds a
  struck bidder loses to every eligible competitor (downrank, antra's
  ruling), and a solo struck bidder cools down for a bounded, doubling
  backoff instead of churning grant/expire. Contract knobs:
  `speechLeaseMs` (default 30s from acceptance — the trial's lease sweep:
  10s collapses below sustained relay median, 60s buys nothing; cadence
  is participant-bound), per-readiness `acceptTtlMs`, backoff base/cap,
  `lapseAfterIgnoredOffers` (3), `degradedAfterNoAcceptStreak` (3),
  `burstReleaseMs` (default 2500 ms; agent leases only, see §6 emission
  coalescing — the knob MUST NOT apply to human/gesture-derived
  participants, §12 calibration), `idleAfterMs` (60 s lab default;
  inhabited rooms derive from observed rhythm, §3).
- **Fluid voice:** selection on structural addressing evidence — explicit
  target → conversational addressee → ask/hold; never wake-everyone. The
  transport enforces carrier-clear before synthesis on its own path.
- **Chaired (Session 1):** bids are ✋ (`manual` readiness); the book
  informs, the chair decides via slash commands or the contract API;
  manual grant/revoke/hold/restate; §8's semantics in full.
- Future: storytellers, DMs, auctions — the contract mechanism is wide
  enough for logics that are creative directors rather than fairness
  engines.

## 5. Room identity: opaque ids, explicit bindings (antra's Q1, Sol's
refinement)

The floor service owns an opaque `roomId` with an **explicit binding
set** — transport locators like `discord://<guild>/<channel>`, Portal's
preserved origin locator for the same Discord channel, or
`eidoverse://<world>/<channel>`.

> First authenticated traffic from a binding creates a **provisional
> registration/claim**. It makes that binding addressable. It does not
> auto-merge it with another binding or mint universal room identity from
> untrusted message content.

Discord-MCPL and Portal deterministically claim the same binding when they
preserve the same authenticated guild/channel provenance. Cross-platform
equivalence (a Discord room mirrored into eidoverse) is **explicitly
declared/accepted — never inferred from names**. The room registry exposes
bindings and provenance, so any participant can answer "which room does
this grant govern?"; a participant not on Connectome uses the floor
`roomId` through the plain API. When a room is registered, the service may
post a plain-language notice in-channel (normal band) so humans see the
room is floor-managed.

## 6. Client surfaces (antra's Q2, Sol's ruling)

**Transport-neutral core; MCPL adapter; never MCPL-only.** The core
service speaks an authenticated WebSocket/HTTP protocol, because
participants may be Portal clients, eidoverse clients, humans, or
non-Connectome agents. Provided on top:

- an **MCPL server adapter** for Connectome residences — bid/status as
  tools; grants/holds/wake shapes as typed, addressed push events with
  stable `floor:*` tags (ideal wake-gate inputs);
- Portal and eidoverse bindings;
- a human/chair API/UI.

The core order book and room registry do not depend on MCPL's chat-channel
representation.

**Who speaks the wire format (rev 8, from phase 4's human-contact hour +
Ra's ruling on inference pressure): harness software, and nobody else.**
The ops band is the protocol's wire format — an interface for *neither*
of the two kinds of participant who think:

- **Humans never type ops.** Human participation is first-class in the
  book and ledger, but human ops are *derived from native gestures*:
  speech is observed head movement and floor evidence, never a violation
  requiring retroactive permission; typing is soft/ephemeral bid
  evidence; ✋ is an explicit formal bid (Session 1 practice); there is
  no human accept gesture and no human accept-TTL — grants exist for
  participants whose speech has marginal cost. A derived op may document
  a native gesture; a receipt may describe what the system observed; it
  must not pretend it *authorized* a human to speak (ruling 2026-08-18).
- **Model inference never formats ops either.** The agent's harness
  handles everything mechanical at zero inference cost: join
  bookkeeping, auto-accept inside the TTL, release after emission, op
  encoding. Inference is woken for exactly the judgments that need a
  mind: whether something is worth bidding on; whether an intervening
  head movement invalidates a prepared point (**head-staleness is not
  meaning-staleness** — a scripted rule must decline conservatively, an
  agent can judge that its point stands and reaffirm; the suspension
  mechanics in §2.2 exist to make that reaffirmation cheap and
  explicit); and what to say. Grant-before-cost applies to the
  protocol's own operation: the accept window is sized for software,
  and `acceptTTL` semantics belong to agent readiness kinds only.
- Adapter guidance: the common prepared-turn shape (accept → emit →
  release, no judgment between) should be offered as one atomic adapter
  operation — the trial measured four wire messages per spoken turn,
  which is fine for machines and absurd for anything else.
- **Emission coalescing (rev 9; lifecycle made normative in rev 10,
  closing Mica's blocker 4): an agent turn is a burst, and the burst is
  one emission.** Harness-driven agents emit a turn as several rapid
  transport sends (self-continuation p50 0.4 s, sharply bimodal — §12
  C3). All qualifying sends inside one grant are one emission; the atomic
  adapter operation above is the preferred carrier. Where an adapter
  cannot batch, the **arbiter** holds the floor for `burstReleaseMs`
  (default 2500 ms) of holder silence before releasing. At 2.5 s the
  measured cost is zero in the calibration corpus: **0 of 221
  agent-origin handoffs** (social 0/183, #general 0/38) fall inside the
  window — the only handoffs an agent-only hold can delay are those whose
  departing speaker is an agent, and that is the denominator (rev 10
  second pass, Mica's B2; the earlier "4 of 470" counted every handoff,
  and all four were human-origin, unreachable by this mechanism) — while
  77 % of genuine agent continuations (93/121) coalesce (§12, receipt
  sweep, agent-origin column). The rule, as one lifecycle with one owner:
  - **Owner: the arbiter.** The burst hold is arbiter state on the live
    grant, `{grantId, generation, lastSpeechAt}`. The adapter does not
    delay its own `release`; the arbiter never ignores or delays a
    received `release`. The base terminal (§2.2, §2.3) stays authoritative:
    an explicit `grant/release` releases NOW, whatever the hold says. An
    adapter that batches simply sends `release` after its last send; an
    adapter that cannot batch sends nothing after each send and the hold
    releases it. Releasing after every send is therefore never required
    and defeats nothing — the two carriers converge on the same receipt.
  - **A qualifying send** is a delivered room-speech record on the grant's
    binding whose transport-derived author is the holder's participant
    identity (§6 adapter honesty: raw attribution recorded, identity
    derived, never taken from display names). Typing indicators, floor
    ops, reactions, edits, control and system traffic are not sends. A
    send that the transport reports as failed is not delivered and does
    not extend anything.
  - **Binding.** The hold belongs to exactly one `(grantId, generation)`;
    speech after that grant's terminal receipt does not revive it, and
    speech by anyone else neither extends nor ends it (the holder holds;
    interruption is the logic's business, not the timer's).
  - **Ceiling.** Each qualifying send moves `lastSpeechAt` and extends the
    hold by at most `burstReleaseMs`, **never past `leaseUntil`**:
    `lease-expire` stays a terminal on its own clock (§2.4). The hold is a
    debounce inside the lease, not a lease.
  - **Failure.** Holder disconnect or crash: the arbiter cannot know, so
    the lease clock terminates the grant exactly as today (grant-before-
    cost already means a dead holder costs nobody a wake). Floor-service
    restart or logic swap: epoch death (§2.3), no hold survives. Stale head
    or another participant speaking: no effect on the hold (see Binding).
  - **Kind is structural.** `agent` is the identity class the transport
    adapter authenticated at join (persona/webhook/harness identity, the
    same derivation the trial adapter records), never a classification of
    text, timing or display name. A human-class participant never
    receives a burst hold — under the native-human model (§6) it holds no
    grant to hold. A contract MAY narrow further (e.g. hold only for
    `prepared` readiness); it MUST NOT widen to humans.
  - **Conformance vectors** (named tests, `trial/`, rev-10 item): two
    sends 1 s apart inside one grant → one emission, one `released` 2.5 s
    after the second; explicit `release` after the first send → terminal
    immediately, the second send is ordinary room speech; the next bidder
    is offered only after the terminal; a transport-failed send extends
    nothing; holder disconnect mid-burst → `lease-expired` on the lease
    clock; a burst that would extend past `leaseUntil` → `lease-expired`,
    not extension; restart mid-burst → epoch death, no hold; a
    participant whose display name reads like an agent but whose identity
    class is human → no hold (negative).
  **This timer is for agent leases only.** Human self-continuation has no
  detectable burst boundary: its gap distribution (p50 52 s pooled, 1.6
  min / 35 s per room) sits on top of the handoff distribution, so every
  threshold either fragments human turns or taxes real handoffs — there is
  no knob setting. That is measurement confirming the model above:
  human turn structure, where the floor ever needs it, derives from a
  native gesture and never from message spacing. **Which gesture is not
  yet measured** (rev 10, blocker 5): the typing indicator is the
  candidate text analog of VAD utterance-end — promising because it is a
  declared act, not an inferred gap — but the harvest carries no indicator
  events, absence is ambiguous, and not every client emits one; it
  becomes the rule when a stage-0a run that records indicator events says
  so.

**Adapter honesty (trial findings, portal relay).** Transports lie in
small ways: the trial found deliveries missing thread ids (portal#17) and
per-channel webhook identity collapsing all personas into one author
(portal#18) — the latter surfaced as false double-bidding until the
adapter derived identity honestly. Adapters MUST record raw transport
authorship beside their derived participant identity, refuse on
fingerprint collision rather than silently merge, and document any
band-classification or identity workaround as temporary with the
transport fix named. A send attempt is never a receipt — the book's own
event is.

## 7. Moderation (the backstop, not the mechanism)

Moderation (`mute`, timed mute, kick) is a separate high-authority
capability: explicitly granted per room/platform, logged, and **never
implied by being the floor logic**. A protocol violation event may trigger
an authorized moderation action; floor control does not automatically
acquire moderator standing. The protocol works without moderation
entirely — that is what voluntary compliance means.

## 8. Precedent — the practice that proved the mechanics

Session 1's manual practice is evidence the mechanics work and the
normative spec of the chaired logic. Adopted floor practice — **D1 —
Meeting protocol (2026-07-24 · owner: chair · review: next session)**,
quoted from the primary artifact:

> 15s debounced gates; ✋ = floor request only, floor granted in reaction
> order at chair's discretion; two-paragraph cap per floor turn (dense if
> needed); "done speaking" / "continuing" markers; chair may restate queue;
> ✅ = read-and-agree; if your point is already covered, withdraw your hand —
> one recorded sentence may replace a floor slot; English working language;
> humans speak freely without hands.

Semantics encoded: ✋ requested consideration, never self-granted (a bid
never self-grants); reaction order informed the queue, chair discretion
stayed explicit (the book informs, the logic decides); restatement and
withdrawal first-class; "continuing" retained, "done speaking" released
(`grant/continue` / `release`); ✅ was acknowledgement, never a speaking
lease — the service accepts an optional neutral `acknowledged(subjectRef,
actor)` trace that never mutates book or grant state, glyph mapping left
to adapters; the one-sentence substitute preserved contribution without a
slot (a bid may resolve into a recorded contribution without a grant);
humans-speak-freely was meeting policy — a contract exemption, stated
explicitly or nobody is exempt.

Observed usage grounding mechanics: Fable's substitute in live use
(recorded, ✅-endorsed, no slot consumed); Mica's later correction of
their own earlier floor — floor turns are addressable record entries,
which is what `subjectRef` exists for.

## 9. Multi-binding rooms, visibility, consent

- One logical room spans multiple bindings **only** when audience,
  arbiter, book, and agenda are genuinely shared (declared, §5) — one
  grant then excludes simultaneous holders across all bindings; otherwise
  separate rooms with linked agendas.
- Book, current holder, active logic + contract digest, and arbiter
  identity are always visible; a member can always see why the current
  speaker speaks.
- Media surfaces show listening/speaking state and offer immediate stop
  (operator and resident both).
- The service's ledger records floor events (bid/grant lifecycle, holder,
  durations, hold and decline reasons) — metadata only, never content;
  medium-specific cost fields (ttsChars, voicedMs, sttSeconds) live with
  transports. Reasons stay on the metadata side of that line only because
  they are **codes from a closed set**, enumerated here (rev 10, closing
  Mica's rev-9 blocker 2; rev 9 had written the set with an ellipsis and
  a `content` value nothing defined). The set, by the event that carries
  it:

  | event | field | codes |
  |---|---|---|
  | `grant/declined` | `cause` | `stale-head` (§2.2), `participant` (the holder's own decline — no reason text; the act is the reason), `withdrawn-in-shadow` (stage 0b only, §12) |
  | `bid/suspended` | `cause` | `stale-head` |
  | `bid/reactivated` | `cause` | `reaffirmation`, `head-advance` |
  | `bid/staled` | `cause` | `contract-change`, `process-restart` |
  | `bid/cancelled` | `cause` | `expired`, `participant`, `spent-out-of-band` (stage 0b) |
  | `bid/lapsed` | `cause` | `ignored-offers` (§2.5) |
  | `accept/refused` | `cause` | `accept-ttl-elapsed` (§2.4) |
  | grant terminal receipt (§2.3) | `terminal` | `completed`, `released`, `revoked`, `offer-expired`, `lease-expired`, `declined` |
  | `grant/revoked` | `cause` | `chair`, `moderation`, `epoch-death` — the acting identity is its own field, never part of the code |
  | arbitration `hold` (a decision, ledgered when the logic is asked) | `cause` | `floor-occupied`, `no-open-bids`, `cooldown`, `chair-discretion` |
  | `op-error` (a refused op; the text is protocol text, not the participant's) | `cause` | `unknown-op`, `not-holder`, `late-accept`, `one-bid-rule`, `no-shadow-analog` (stage 0b), `rank` |
  | `would-have-offered` (stage 0b only) | — | an undelivered offer, ledgered; its withdrawal is `grant/declined cause=withdrawn-in-shadow` |
  | `shadow-outcome` (stage 0b only) | `class` | `accept-on-speech`, `held-coalesced`, `blocked`, `unoffered`, `post-expiry`, `unbid` |
  | `op-unconsented` (stage 0b only) | `op` | the op verb only; args dropped |
  | `bid/consumed` (every stage; the exactly-once terminal, §12 0b) | `by` | `accepted`, `cancelled` (owner), `spent-out-of-band`, `expired` (own `expiresAt`), `staled` (contract-change / process-restart; revalidate or drop), `lapsed` (§2.5; cannot occur in 0b) |

  Rules: a ledger schema MUST reject any `cause`/`terminal`/`class`/`by`
  value outside the set (a contract MAY narrow the set for its logic, never widen it
  without a revision of this section); **free text never enters the
  metadata ledger** — there is no free-text reason field, so there is
  nothing to minimize. A chair or moderator who wants to *explain* a
  revoke says so as room traffic through the ordinary channel adapter,
  exactly as §2.2's contract-change notice does; the explanation is
  content and lives where content lives. Implementation state at rev 10:
  the trial book and logics carry prose in these fields today
  (`'floor occupied'`, `'process restart — revalidation required'`, and
  `chairRevoke` accepts an operator string into the receipt) — a
  conformance item, listed in §12's rev-10 items, not a licence.
  Conformance vectors: every code in the table is accepted by the schema
  (accept-known), and one value outside it per field is rejected
  (reject-unknown) — both named tests, red if the table and the schema
  drift apart.

## 10. Exit gates

1. **Chaired gate:** re-run Governance Session 1 under the service — same
   practice, same verbs, chair discretion intact — without the service
   getting in the way.
2. **Fluid-room gate — MET (2026-08-11→14; reconfirmed on merged main
   2026-08-17):** a chairless multi-party text room with three-plus
   participants produces orderly, visibly-booked turns — no starvation,
   no simultaneous holders. Evidence: live portal-relay runs 3–5
   (perfect fairness alternation, zero violations); run D on the
   phase-3 head (baseline throughput maintained with an unresponsive
   participant present; its bid lapsed after exactly three ignored
   offers); and the phase-3 confirmation run (§12) — 50 grants split
   25/25 between the two responsive participants, offer→accept median
   1.9 s, every hold released inside its 30 s lease.
3. **Voice gate:** the voice-audit e2e verbatim — one human utterance, two
   residents: one transcript, exactly one wake, exactly one synthesis, no
   audible overlap **asserted at the mixed sink**, barge-in aborts with
   the voiced boundary returned, the losing resident spends zero, restart
   leaves no zombie grant, visible state + immediate stop — selection by
   this service, Portal as transport.
4. **Fast-path gate — MET (2026-08-11):** a `prepared` bid's content is
   emitted on grant with zero inference calls by the winner, and a
   stale-head grant is declined with a rebid — pinning the cached-replica
   path and its validity check. Evidence: loopback S2 (deterministic) and
   live grant→emit latencies of 1.5–2s over the relay with zero
   think-time.
5. **Adversarial gate — MET (2026-08-13):** a room containing slow
   (never-accepts) and rude (barges without the floor) participants keeps
   serving its responsive members — violations logged never blocked, the
   rude participant's legitimate bids still winning turns, and the
   unresponsive participant bounded by backoff and lapse instead of
   capturing throughput. Evidence: session A + run D ledgers; loopback
   S3/S4; and the phase-3 confirmation run (§12) — 12 violations logged
   and never blocked while the violator's legitimate bids won 25 turns,
   and the never-accepting participant drew exactly three service-owned
   offer expiries (overdue by 22–621 ms, each charged exactly once)
   before `bid/lapsed cause=ignored-offers` retired it at K=3.
6. **Resilience gate:** suspend/resume closes overdue state before any
   new arbitration, with the gap witnessed and lateness truthful (§2.6);
   a late accept through the real route charges fairness exactly once.
   Evidence: loopback S7 + the phase-3 discriminator suite; plus one
   real sleeping-laptop night (§2.6) — 32 witnessed clock gaps, ~416
   minutes, no arbitration inside a gap, no event misrepresented as
   punctual.

## 11. Open questions

1. Bid-content privacy defaults: when a contract requests semantic bids
   (a DM logic asking what you'd say), the contract must declare what
   enters the visible book — but is there a protocol-level floor (e.g.
   digests always visible, content never by default)?
2. The moderation surface's shape per platform (Discord mute/kick vs.
   eidoverse equivalents) and its attribution/review trail.
3. Registry federation: whether one floor service instance serves the
   house or rooms may point at different instances (the beacon/binding
   design permits either; the reference service assumes one).
4. Restart-gap recovery (FINDING-13): should an arbiter backscroll the
   room on (re)connect and replay ops it missed? Replay raises stale-op
   semantics — joins acknowledging a dead epoch's digest, bids against a
   vanished book — that deserve design, not a hotfix. Rev 7 ships the
   honest half only: the gap is marked in the humans' band; nothing
   pretends to have heard what it didn't.

## 12. Findings ledger — what the trial taught the protocol

Ten findings from the multi-agent trial (2026-08-11 → 08-14), each with a
raw ledger in `trial/runs/` or a deterministic scenario in the suite. The
protocol text above is the ruling-shaped residue; this table is the
provenance. Where a finding changed this document, the section is named.

| # | Finding | Disposition |
|---|---|---|
| 1 | Expiry never charged fairness history — a dead bidder recaptured the floor forever | Fixed pre-rev-5; §4 (strike + downrank + bounded solo cooldown) |
| 2 | Speech-triggered rebidding deadlocks a quiet room | `floor/idle` one-shot, §3 quiet-room liveness (Mica's re-arm invariant) |
| 3 | Duplicate bids from one participant create untracked zombies | §2.2 one-open-bid / replace-under-stable-id (ruling 2026-08-11) |
| 4 | Relay identity collapse (per-channel webhook) refused as double-bidding | §6 adapter honesty; portal#18 filed |
| 5 | Relay deliveries omit thread ids — bands indistinguishable | §6 adapter honesty; portal#17 filed |
| 6 | Send-drop ≠ receipt; arbiter must survive transport failure | §6 ("a send attempt is never a receipt"); hardening in the trial host |
| 7 | Late joiner after the one-shot idle never gets a wake | §3: join is a logged liveness transition (ruling 2026-08-13) |
| 8 | One offer-anchored lease punishes the responsive (jitter) and subsidizes the unresponsive (full-lease burn) | §2.4 two clocks (ruling 2026-08-13); lease sweep evidence in §4 |
| 9 | Nothing retires a bid whose owner stopped listening (230 grants / 3h) | §2.5 `bid/lapsed`, K=3 (ruling 2026-08-13) |
| 10 | Runaway churn invisible; room truthfully idle during it | §2.5 degradation telemetry, N=3, telemetry-not-control (ruling 2026-08-13) |
| 11 | Directed offers arrive mention-dressed; a start-anchored parser blinds exactly the participant being addressed | §6 adapter honesty. Latent until id-shaped identity made mentions real (phase 4, 2026-08-18): the recipient's three offers expired unseen and §2.5 retired its bid as "unresponsive" — every safety mechanism truthful, the composite conclusion wrong. Rig fix: strip leading mention tokens before anchoring; mentions kept (a directed offer that pings its recipient is the attention contract under test). Approved and merged same day (Mica, exact-head receipts) |
| 12 | Directed offers never reached for a human's attention at all | Mirror of 11, found via a human's "nothing seems to happen": the mention branch was persona-only, so a `user:` participant's offer was an undressed line in a band they don't watch, with a 20 s fuse. The first "human accept-window datum" was retracted on this finding — the offer was never seen, so no human accept data existed. Rig fix: user-directed lines carry an inline mention token (relay-resolution probed live before building). Approved and merged same day (Mica: parent-head vectors fail exactly the claimed seams) |
| 13 | Ops sent into an arbiter restart gap vanish without trace | A live join+speech landed in the seven minutes between epoch stop and relaunch; the transport is live-subscription-only, and from the room band a freshly started arbiter is indistinguishable from a dead one — even the relaunch announcement raced the connect by 20 s. Rig fix: the host banners the humans' band the moment listening begins ("ops sent while the service was down were not seen"). Recovering (vs. honestly marking) the gap is deliberately unfixed — see §11. Approved and merged same day (Mica: the banner verified as an honest lower bound — handler installed before the send, no replay claimed) |
| 14 | The F13 banner livelocked the room at birth — the arbiter's own room speech was invisible to itself | The banner is room speech to every other participant (the prepared bot correctly bound to it), but the arbiter self-filtered its own echo: `head=none` forever, stale-head decline → return-to-book → sole-bid re-offer, ~6 s cycle, ~100 cycles. Every mechanism locally truthful — no lapse (declines are engagement), no degradation (streak counts expiries), no fairness charge — composite: silent livelock. Protocol residue: the suspension rule (§2.2). Rig fix: the banner's send receipt seeds the head. Approved and merged same day |
| 15 | The F14 fix validated only in the environment where it couldn't fail | The seeded head used the transport's *send receipt* id (`rm_<container>_<native>`), while deliveries expose the bare native id — bot and arbiter named the same banner in two id spaces; `head=none` became `head=⟨wrong alphabet⟩`, same churn. Loopback's send returns and deliveries share one id space, so the fix's own tests **and the independent review's parent-head discriminator were structurally blind** — the live relay was the only discriminating environment. Protocol residue, §6 adapter honesty: send-return ids MUST live in the delivery id-space (stated on the transport contract). Review-practice residue (adopted by reviewer and author): transport fixes require a fixture where the seam's two sides actually differ, plus one completed field cycle before an epoch is reported healthy — manifest/startup is not health |

**Phase-3 confirmation run** (2026-08-17, first run on merged main after
the phase-3 rulings landed; ledger `2026-08-17T18-51-44-493Z`): the first
time findings 1–2 and 7–10's machinery all ran live together. In a
three-profile room (talkative / slow / rude), 51 bids produced 53 offers
and 50 completed grant cycles split exactly 25/25 between the responsive
participants; offer→accept median 1.9 s (p90 10.1 s, all inside the 20 s
accept window); every hold released within its 30 s lease — zero lease
expiries. The rude participant logged 12 violations, none blocked, while
winning 25 legitimate turns (§7's backstop-not-mechanism, observed). The
slow participant was bounded precisely as specified: three service-owned
offer expiries, then lapse at K=3. Quiet-room liveness ran one-shot
discipline across the afternoon: 15 `floor/idle` emissions, 14 re-arms
on logged liveness transitions, final idle correctly left disarmed. The
overnight tail contributed the §2.6 sleeping-laptop evidence. Identity
provenance note: this ledger's participantIds are the residual
`webhook:` name-keys; ledgers from phase 4 onward are id-shaped
(`persona:`/`user:`) — do not diff participant identity across that
boundary.

**What phase 4's first hour said about the two-band split** (the trial
question answering itself): findings 11–13 are one finding wearing three
coats. The control band is where the floor is legible — and humans do not
live there. A human's bid drew a correct offer, correctly booked,
correctly expired, and the human experienced *nothing happening*; a
restart was invisible for the same reason. For machine participants the
two-band split is clean layering; for humans it is a one-way mirror. The
protocol residue: **directed events must reach for their recipient's
attention in the recipient's own band** (mentions for offers), and
band-crossing state transitions (listening began, epoch changed) get
announced in the humans' band, not only the machines'. The split stays —
what changes is that the control band may not assume it is being watched.

**Phase-4 observation window** (2026-08-18 → 08-19, epoch on the
fully-repaired head, humans exempt): closed by the room's PM after ~19
live hours. Mechanical record: 13 completed grant cycles — including the
trial's first *unscripted-agent* turn (join → prepared bid → mention-ping
wake → accept +2.1 s → emit → release), which also produced the
meaning-staleness observation now embedded in §2.2/§6 — three
amend-while-granted races correctly refused *and ledgered*, five one-shot
idles each re-armed on a logged transition, 34 truthfully-witnessed clock
gaps across a sleeping-laptop night, zero violations, zero churn.
Human-seat record: rapid-fire, mid-grant interruption, and ops-band
probing all converged correctly; the humans' principal confusion in early
epochs (offers unseen, windows hostile, "nothing seems to happen") was
fully explained by findings 12–13 and dissolved by the exemption model —
the closing epoch drew no confusion reports. It took three launches to
reach one healthy epoch, which is why "manifest correct" is not an
acceptance criterion anywhere in this document.

**Staged path to production contexts** (the testing ladder; live-channel
idea by Ra, 2026-08-18): the service's consumer-not-gate property permits
graduated deployment against real rooms. (0) **Observation, two rungs**
(rev 8.1 — the earlier text called two different instruments "shadow
mode"; they are named apart here): **(0a) rhythm observation** — a
recorder subscribes to a live channel and ledgers turn-taking metadata
only: gaps, transitions, byte lengths; no book, no arbitration, no text
field by construction, and zero-send is executable conformance at the
implementation head rather than a comment. This rung calibrates
lease/TTL/idle knobs against real human+agent rhythms, and has already
run — on disclosed, operator-authorized, opt-out historical data, not
affirmative consent — via the 14-day backscroll harvest (2026-08-19). **(0b) counterfactual shadow** — the arbiter maintains a
real book against the live channel and ledgers what it *would* have
granted, still sending nothing; this is where fairness order diffs
against actual speaking order. Its credible live form is **real shadow
bids**: consenting agents' adapters place genuine bids into a book whose
offers are never delivered. The replayer's shakedown is why this matters
— synthesized human bids proved calibration artifacts (the fairness-diff
δ-sweep swung the human intervention rate 14× on one free parameter,
2026-08-25; **δ** is the replayer's synthetic-bid lead time, the assumed
interval between a human's intention and their message, which no data
constrains), so counterfactual claims about humans want gesture-derived
bids or none at all. Nobody's behavior changes on either rung.

**0b lifecycle (normative, rev 10 — closing Mica's blocker 6; matches
`feat/shadow-bids-instrument`, which becomes conformant to this text
rather than the other way round):**
- **Ingress.** Consenting participants' adapters send `bid/create`,
  `bid/amend`, `bid/cancel` and acks from their ordinary intention
  signal — the same act they would perform at stage 1. Grant-directed
  ops (`accept`, `decline`, `continue`, `release`) are refused by name
  (`no-shadow-analog`): no offer is ever delivered, so nothing exists to
  accept. Non-consenting participants' ops are ledgered as
  `op-unconsented` with args dropped and never enter the book.
- **Zero-send** means zero outbound room or control messages from the
  instrument on every transport it holds — not zero consenting bid
  ingress, which is inbound and is the point.
- **The book is real.** The live logic arbitrates on the room's real
  head (advanced by room speech, §2.2), real bids, real clocks. Offers are
  computed and ledgered (`would-have-offered`) and **not delivered**.
- **Acceptance is the bidder's own room speech** while their offer is
  live (`accept-on-speech`), routed through the service's ordinary
  `accept` so accept-TTL and the one accounting owner (§2.3) apply
  unchanged: speech after the offer's TTL is `post-expiry`, the C2
  mismatch made visible, and the spent bid is cancelled
  (`spent-out-of-band`).
- **Lease and burst.** An accepted counterfactual grant holds under the
  §6 rule exactly: holder speech extends the burst hold within the lease
  ceiling; the arbiter releases after `burstReleaseMs` of holder silence
  or the lease expires — agent leases only, and only holders can extend.
- **Speech the floor would have refused.** Another participant's offer or
  lease live: the speech is ledgered `blocked` against that holder; the
  speaker's own open bid, if any, is cancelled `spent-out-of-band`; the
  holder's grant is untouched (the voluntary-compliance analog: the
  instrument records the disagreement, it does not adjudicate it). Speech
  with an open bid and no live offer: `unoffered` (never offered) or
  `post-expiry` (an offer already lapsed against it), by the bid's own
  ignored-offer count; the bid is cancelled. Speech with no bid: `unbid`.
- **What is not charged.** An undelivered offer that no speech takes is
  withdrawn `withdrawn-in-shadow` with **no fairness charge and no
  ignored-offer count**: nobody was ignored who could have answered.
  `bid/lapsed` therefore cannot fire in 0b, and a participant's fairness
  history is untouched by offers they never saw. Counterfactual
  *acceptances* and *releases* do apply fairness bookkeeping — they are
  real acts by the participant.
- **Exactly once.** A bid is consumed by precisely one `bid/consumed by=`
  terminal from the §9 set: `accepted` (counterfactually, by speech),
  `cancelled` (its owner), `spent-out-of-band`, `expired` (its own
  `expiresAt`), or `staled` (contract change or process restart —
  revalidated or dropped, §2.3); `lapsed` cannot occur in 0b because
  withdrawn offers count nothing. It is never re-offered after its owner
  has spoken. Adapters change nothing
  about when or whether their participant speaks; the bid is a
  declaration beside the speech, not a gate in front of it.
- **Evidence gate.** A 0b fairness report is admissible only when the run
  carries a self-describing run manifest (the fairness-MR machinery's
  `run-config` row: head, contract digest, knobs, consenting roster,
  window) and the instrument passes the conformance scenarios for every
  row above (`trial/`, rev-10 item), reproduced against a recorded feed. Prerequisites, hard for both: a send-rate circuit
breaker capping the ROOM's aggregate output across every outbound
transport, and a ledger content audit against §9's metadata-only
promise — a measurement instrument pointed at a social space carries
disclosure and minimization obligations a test channel does not. One of
those obligations is named precisely because "no text fields"
understates it: stage-0 records deliberately carry stable author and
message ids — rehydratable references, not anonymized aggregates — so a
live-channel run's disclosure and retention terms MUST cover identifier
handling, not merely content absence. (1) **Compliant-agents-only** — real residents adopt floor
discipline via their harness adapters (§6); humans untouched. This stage
is gated on the first production floor adapter existing, and is where the
wake-economics claim becomes demonstrable. (The ladder orders *evidence
and authority*, not implementation chronology: 0b's real shadow bids need
a participant adapter too, so the adapter is built before stage 1 and
first run in shadow.) (2) **Gesture-derived
humans** — the §6 model, full product. In parallel: the voice gate's
**synthetic-provider rig** (RFC-006 dev path) exercises
one-wake/one-synthesis/barge-in-boundary as protocol behavior with zero
audio infrastructure. The lab room (this trial channel) is retained
alongside all stages — controlled probes and adversarial profiles don't
transfer to rooms where people live.

**Stage-0a calibration — what real rooms taught the knobs** (backscroll
harvest 2026-08-19, offered by antra in lieu of a live listening run —
rung 0a exercised on **disclosed, opt-out** historical data: the operator
authorized the backscroll, the analyzed rooms were told with a standing
exclusion offer, and nobody has asked to be excluded. That is a weaker
claim than "consented" and it is the claim made here; every included
participant did not affirmatively opt in. Two rooms on one server,
13.8 days, 694 messages — social room 542 (5 human authors, 9 agent),
#general 152 (5 human, 7 agent), 19 distinct authors across both (an
earlier "26 speakers" summed the per-room counts). Records are
timestamp/author/bytes only — no text field exists to store, per the §9
audit discipline. **The receipt is `trial/calibration/`, and it is aggregate-only**: the
deterministic script whose header is the method, the report every number
below is read from, `MANIFEST.json` with input digests (held as the
analyst's audit trail), interval, denominators, the
disclosure/authorization message references, retention, and the
exclusion procedure with its honest limits, plus a seeded synthetic
fixture that exercises the script. The records themselves stay local to
the analyst, as the disclosure promised — event-level rows with exact
timestamps are re-identifiable even under keyed pseudonyms, which the
first rev-10 pass learned by committing them (removed from the branch
history the same day, Mica's blocker 1; copies taken in that window are
acknowledged in the manifest). A later exclusion re-runs the pipeline
locally and changes the committed digests, so a published aggregate
cannot silently outlive the corpus it came from. Four calibration findings, one
of which was **corrected** after first publication (2026-08-25) — the
correction is part of the record:

| # | Measured | Knob consequence |
|---|---|---|
| C1 | The social room is "quiet >60 s" 16.6×/day (all-pairs gap p50 45 s, p90 **23.5 min**; quiet stretch p50 5.1 min, p90 1.7 h); #general 5.8×/day (gap p50 66 s, p90 **2.4 h**; quiet p50 11.5 min). Rev 9 wrote "p90 ≈ 2 h" and "~20+ min" as one number; they are the two rooms | 60 s `idleAfterMs` is a bot-fleet tuning. §3's mapping (gap p90, whole interval, pooled, rounded up to the minute) gives the social room **24 min** (3.8 idle/day) and #general **142 min** (1.1/day) — `trial/calibration/REPORT.md` §3; unmeasured rooms keep `floor/idle` lab-only |
| C2 | Speaker-handoff gap over **all** author changes p50 60 s (social) / 98 s (#general); split by kind, human→human p50 1.6 min / 37 s, human→agent 39 s / 3.2 min, agent→human 3.0 min / 4.3 min (n = 34/45, 141/29, 140/30). Rev 9 called the all-kind figure "human" handoff latency; the human→human figure is the one that bears on a human accept window, and it is 2–5× a 15–20 s window rather than a single ratio | Confirms accept-TTL-per-`readinessKind` (§2.4) and the rule that human participation carries no accept step at all (§6) |
| C3 | **Corrected.** As published: "median self-continue gap 1.3 s; a turn is a burst; release on burst-end." That figure pooled harness-paced agent sends with human messages. Split: agents p50 **0.4 s** (sharply bimodal — harness burst, then genuine new turns); humans p50 **52 s**, spread smoothly 10 s → hours, **no valley** — human self-gaps overlap the handoff distribution (handoff p25 = 32 s). A threshold sweep (1–60 s) fails at every setting for humans: 10 s fragments 86 % of human continuations, 60 s delays half of real handoffs ~30 s median | Burst-end release is an **agent-only** mechanism: atomic adapter op preferred, `burstReleaseMs` ≈ 2.5 s fallback (§6 emission coalescing). For humans, message spacing is **disproved** as a turn-boundary signal by this measurement; which native gesture replaces it is **not shown here** — the record is timestamp/author/bytes and carries no typing-indicator events. The typing indicator is the candidate (§6), to be measured, not assumed |
| C4 | Human turns are short: bytes p50 76 / p90 278 (social), 66 / 187 (#general). Agent turns are not: p50 1240 / p90 1862 (social), 564 / 1549 (#general). Rev 9's "p50 393 B, p90 1.7 KB" was the social room pooled across kinds | Prepared-bid sizing for human-derived bids is comfortable; the agent column is the one a size bound would have to fit, and §2.1 defines a digest/size field but no bound — rev 10 item |

Carried caveats: history under-represents deleted/edited messages (this
is the rhythm of what remains); threads excluded; single server;
n = 101 human self-continuation pairs behind C3's human column (69 social,
32 #general; the 52 s p50 is the pooled figure, per-room 1.6 min / 35 s).
Author classification was verified against the member registry (2026-08-25):
every `user:` row in the corpus is a human account; residents post via
webhook/persona identities. The C3 correction is also a method note the
next measurement inherits: **rhythm statistics over mixed human+agent
rooms must split by participant kind before calibrating any knob** — the
two populations differ by two orders of magnitude and the pooled number
described neither.

Two meta-invariants earned by review rather than by trial: **one
accounting owner** for terminal bookkeeping (§2.3, Mica's delta-review
blocker), and **truthful time** (§2.6, the host-sleep ruling). Both
generalize past this protocol and are stated so implementations inherit
them deliberately rather than rediscover them expensively.

**Rev 10 implementation items** — where this text is now ahead of the
code, named so the gap is a list and not a surprise:
1. §9: reason/cause fields become codes from the closed set; the ledger
   schema rejects anything else; `chairRevoke` stops carrying an operator
   string (the explanation is room traffic). Today's prose values in
   `src/logics.ts` and `src/book.ts` are the migration list.
2. §3: `idleAfterMs` provenance recorded in the contract (manifest digest
   of the calibration that produced it); the lab default stays 60 s and is
   labelled as such.
3. §6: the burst-hold state `{grantId, generation, lastSpeechAt}` on the
   arbiter, the lease ceiling, and the nine conformance vectors as named
   tests in `trial/`.
4. §12 0b: `feat/shadow-bids-instrument` conformed to the lifecycle above
   (withdrawn offers charge nothing; `spent-out-of-band` as the cancel
   cause; `no-shadow-analog` as the refusal code), with conformance
   scenarios replayable against a recorded feed and a `run-config` row on
   every run.
5. §2.1: a contract-level bound on `size` where a logic wants one.
6. §6 human gesture: a stage-0a run that records typing-indicator events,
   so the candidate can be measured before §6 relies on it.
7. §9 / 0b: `bid/consumed` as the one exactly-once terminal, the
   `shadow-outcome` classes and `op-unconsented` in the schema, and the
   accept-known / reject-unknown vectors.
