# Ledger content audit — §9 conformance (2026-08-19)

RFC §9 promises: *the service's ledger records floor events — metadata
only, never content.* This audit enumerates every record the trial rig
writes, classifies each field, and records the one repair it forced. It
exists so a run pointed at a channel people live in (rev 8 testing
ladder, stage 0) can cite its instrument's handling of what passes
through it, rather than asserting it.

## Record inventory (writers: `trial/host.ts`, `trial/run-portal.ts` via
## `onAnomaly`, `trial/shadow.ts`)

| kind | fields | class |
|---|---|---|
| `manifest` | git head/branch/dirty, channel ids, knobs, exemptIds, sendBudget | config metadata |
| `op` | at, participantId, verb, id, parsed args (ids, readiness, digests), raw relay attribution | metadata — op args are protocol values; a bid's `digest` is a hash, its `subject` a message id. A decline's `reason=` arg is the one place the band grammar admits text: it is normalized to its §9 code (`stale-head`) or dropped (`participant` — the act is the reason) before the row is written (rev 10 §9; `test/host-closed-codes.test.ts`) |
| `op-error` | op fields + `cause`, a code from §9's closed set (`unknown-op`, `not-holder`, `late-accept`, `one-bid-rule`, `no-shadow-analog`, `rank`); the refusal's prose goes to the control band, not the ledger | metadata |
| `host-invariant` | op fields + the service's own error text — not a participant refusal; the host failing its own invariant, kept distinct so it is never dressed as an `op-error` | metadata (protocol text) |
| `accept/refused` | ids + `cause=accept-ttl-elapsed` (was `late-accept-refused`) | metadata |
| `violation` | at, participantId, messageId, raw attribution — **no message text** | metadata |
| `event` | the book's own event stream (bid/grant lifecycle incl. the exactly-once `bid/consumed by=`, telemetry); every coded field (`cause`, `terminal`, `by`) is a §9 code — the book refuses to emit anything else (`src/codes.ts`) | metadata by construction |
| `idle` / `idle-rearm` / `clock-gap` | timings, causes | metadata |
| `identity-refusal` (anomaly) | derived id, fingerprint pair, raw attribution | metadata |
| `send-drop` (anomaly) | persona, error, **content handling below** | repaired |
| `send-breaker-trip` / `-reset` (anomaly) | persona, budget, timestamps, suppressed count | metadata |
| `send-breaker-final` (anomaly) | trip timestamp, suppressed count, notice settlement — shutdown-while-tripped snapshot | metadata |
| `send-breaker-notice-abandoned` (anomaly) | persona, timestamp — the trip notice never landed | metadata |
| `speech-rhythm` (shadow) | at, authorId, messageId, byte length, surface, thread presence | metadata — see below |

## The schema rule (rev 10 §9)

Every row passes `assertClosedCodes` before it is written (`trial/host.ts`
`ledger()`): a coded field outside the closed set, or a `reason` key on
any row, throws — a ledger that would have lied is a ledger that stops.
The accept-known / reject-unknown vectors are `test/closed-codes.test.ts`.

## The one repair

`send-drop` previously ledgered `contentPreview` — the first 80
characters of the outbound message. Every current sender is
machine-authored, but the field was structurally a content field in a
generic transport. Now band-aware (`previewOf`): protocol-band lines
(`⟨floor⟩` / `!floor`, mention-dressed or not) keep a bounded preview —
they *are* metadata; anything else is described as
`{contentBytes, contentWithheld: true}`. Pinned by test
(`test/send-breaker.test.ts`, §9 case).

## Identity

`raw` relay attribution (display names, user ids) is retained: §9 makes
holder identity and "why the current speaker speaks" *deliberately*
visible. Identity is not content. Rooms wanting pseudonymous ledgers
would do that at the participantId layer (§5 opaque ids), not by
redacting the ledger.

## Shadow mode (stage 0)

`trial/run-shadow.ts` records `speech-rhythm` entries only: timestamp,
author id, message id, **byte length**, band classification. No text
field exists in the record shape — the recorder cannot leak what it
never accepts (`trial/shadow.ts`, pinned by test). The shadow runner
never sends — and that claim is executable, not asserted: the runner
core (`startShadow`) is handed a transport whose send methods are fully
available, and conformance drives observed traffic plus shutdown
through it asserting zero room/control sends
(`test/shadow-runner.test.ts`; adding any send turns it red). The run
manifest declares `mode: 'shadow'`.

Remaining before a live-channel shadow run is *social*, not technical:
target-channel choice, disclosure to its regulars, and read access for
the service persona — antra's blessing, all three.
