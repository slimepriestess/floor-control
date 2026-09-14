/**
 * FLOOR-RFC-001 §9 — the closed vocabulary, as data.
 *
 * Reasons stay on the metadata side of the content line only because they
 * are codes from a closed set. This module IS that set: one table, keyed by
 * the event that carries the field, and one assertion the ledger runs on
 * every record. A value outside the table is refused at the source — the
 * book will not emit it, the trial host will not ledger it — so drift
 * between this file and §9's table shows up as a red test, not as prose in
 * a ledger somebody has to minimize later.
 *
 * There is no free-text reason field. A chair who wants to *explain* a
 * revoke says so as room traffic; the explanation is content and lives
 * where content lives (§9). The assertion below rejects a `reason` key on
 * any record for exactly that reason.
 */

export const DECLINE_CAUSES = ['stale-head', 'participant', 'withdrawn-in-shadow'] as const;
export const SUSPEND_CAUSES = ['stale-head'] as const;
export const REACTIVATE_CAUSES = ['reaffirmation', 'head-advance'] as const;
export const STALE_CAUSES = ['contract-change', 'process-restart'] as const;
export const CANCEL_CAUSES = ['expired', 'participant', 'spent-out-of-band'] as const;
export const LAPSE_CAUSES = ['ignored-offers'] as const;
export const ACCEPT_REFUSED_CAUSES = ['accept-ttl-elapsed'] as const;
export const TERMINALS = ['completed', 'released', 'revoked', 'offer-expired', 'lease-expired', 'declined'] as const;
export const REVOKE_CAUSES = ['chair', 'moderation', 'epoch-death'] as const;
export const HOLD_CAUSES = ['floor-occupied', 'no-open-bids', 'cooldown', 'chair-discretion'] as const;
export const OP_ERROR_CAUSES = ['unknown-op', 'not-holder', 'late-accept', 'one-bid-rule', 'no-shadow-analog', 'rank'] as const;
export const SHADOW_OUTCOME_CLASSES = ['accept-on-speech', 'held-coalesced', 'blocked', 'unoffered', 'post-expiry', 'unbid'] as const;
export const CONSUMED_BY = ['accepted', 'cancelled', 'spent-out-of-band', 'expired', 'staled', 'lapsed'] as const;

export type DeclineCause = (typeof DECLINE_CAUSES)[number];
export type SuspendCause = (typeof SUSPEND_CAUSES)[number];
export type ReactivateCause = (typeof REACTIVATE_CAUSES)[number];
export type StaleCause = (typeof STALE_CAUSES)[number];
export type CancelCause = (typeof CANCEL_CAUSES)[number];
export type LapseCause = (typeof LAPSE_CAUSES)[number];
export type AcceptRefusedCause = (typeof ACCEPT_REFUSED_CAUSES)[number];
export type RevokeCause = (typeof REVOKE_CAUSES)[number];
export type HoldCause = (typeof HOLD_CAUSES)[number];
export type OpErrorCause = (typeof OP_ERROR_CAUSES)[number];
export type ShadowOutcomeClass = (typeof SHADOW_OUTCOME_CLASSES)[number];
export type ConsumedBy = (typeof CONSUMED_BY)[number];

/** §9's table, row for row: the event (book event `type`, or trial ledger
 *  record `kind`) → the coded field it carries and the codes allowed there.
 *  `field: null` means the row carries no code (`would-have-offered`), and
 *  `codes: null` means the field is an open identifier rather than a code
 *  (`op-unconsented.op` is the verb — args are dropped, never ledgered). */
export const CLOSED_CODES: Readonly<Record<string, { field: string | null; codes: readonly string[] | null }>> = {
  'grant/declined': { field: 'cause', codes: DECLINE_CAUSES },
  'bid/suspended': { field: 'cause', codes: SUSPEND_CAUSES },
  'bid/reactivated': { field: 'cause', codes: REACTIVATE_CAUSES },
  'bid/staled': { field: 'cause', codes: STALE_CAUSES },
  'bid/cancelled': { field: 'cause', codes: CANCEL_CAUSES },
  'bid/lapsed': { field: 'cause', codes: LAPSE_CAUSES },
  'accept/refused': { field: 'cause', codes: ACCEPT_REFUSED_CAUSES },
  'grant/revoked': { field: 'cause', codes: REVOKE_CAUSES },
  'arbitration/hold': { field: 'cause', codes: HOLD_CAUSES },
  'op-error': { field: 'cause', codes: OP_ERROR_CAUSES },
  'would-have-offered': { field: null, codes: null },
  'shadow-outcome': { field: 'class', codes: SHADOW_OUTCOME_CLASSES },
  'op-unconsented': { field: 'op', codes: null },
  'bid/consumed': { field: 'by', codes: CONSUMED_BY },
};

/** Every grant terminal receipt carries one of these (§2.3, §9). */
export const CLOSED_TERMINALS: readonly string[] = TERMINALS;

/** A record as the ledger sees it: a book event (`type` + `data`) or a trial
 *  ledger row (`kind` + fields; `kind: 'event'` wraps a book event). */
export type LedgerRecord = Record<string, unknown>;

export class ClosedCodeViolation extends Error {
  constructor(readonly event: string, readonly field: string, readonly value: unknown) {
    super(`closed set (§9): ${event}.${field} = ${JSON.stringify(value)} is not a code from the table`);
    this.name = 'ClosedCodeViolation';
  }
}

/** The schema rule from §9: a ledger MUST reject any coded field outside
 *  the set, and free text never enters. Throws; never coerces. */
export function assertClosedCodes(record: LedgerRecord): void {
  const kind = typeof record.kind === 'string' ? record.kind : undefined;
  const type = typeof record.type === 'string' ? record.type : undefined;
  const name = kind && kind !== 'event' ? kind : type;
  // Where the coded fields live: a bare book event keeps them under `data`;
  // a trial row keeps them at the top level (a wrapped book event has both
  // `kind: 'event'` and the spread event fields, so `data` is checked).
  const fields = (record.data && typeof record.data === 'object' ? record.data : record) as Record<string, unknown>;
  if ('reason' in fields || 'reason' in record) {
    throw new ClosedCodeViolation(name ?? '?', 'reason', (fields.reason ?? record.reason));
  }
  if (name === undefined) return;
  const row = CLOSED_CODES[name];
  if (row) {
    if (row.field !== null) {
      const value = fields[row.field];
      if (row.codes === null) {
        if (typeof value !== 'string' || value.length === 0) throw new ClosedCodeViolation(name, row.field, value);
        if (name === 'op-unconsented' && 'args' in fields) throw new ClosedCodeViolation(name, 'args', fields.args);
      } else if (typeof value !== 'string' || !row.codes.includes(value)) {
        throw new ClosedCodeViolation(name, row.field, value);
      }
    }
  }
  // Terminal receipts ride grant/* terminal events as `terminal`.
  if ('terminal' in fields && (typeof fields.terminal !== 'string' || !CLOSED_TERMINALS.includes(fields.terminal))) {
    throw new ClosedCodeViolation(name, 'terminal', fields.terminal);
  }
}

/** A protocol refusal that carries its §9 `op-error` code. Anything the
 *  book or service refuses on a PARTICIPANT's behalf throws one of these;
 *  a plain Error is an invariant failure, which is the service's problem. */
export class FloorRefusal extends Error {
  constructor(readonly code: OpErrorCause, message: string) {
    super(message);
    this.name = 'FloorRefusal';
  }
}
