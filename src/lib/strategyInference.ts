/*
 * strategyInference.ts — decides which Strategy a ticker's transactions
 * actually look like, from the transactions alone. Pure, no React/DOM.
 *
 * Used in two places: (1) CSV import, to label freshly-parsed positions
 * before the user confirms; (2) storage normalization, to self-heal
 * positions that were labeled under an earlier/cruder version of this
 * logic (e.g. everything with a put leg used to be called "wheel" even
 * when it was really a put vertical or a strangle).
 *
 * There is no separate "wheel" strategy: a cash-secured/margined short put
 * with no stock yet is just the one-legged case of 'strangle' (displayed as
 * "Short Put" — see positionStrategyLabel in PositionDetail.tsx), and the
 * instant it gets assigned, hasStock flips true and the SAME position
 * becomes 'covered_call' automatically, cost basis and all — no manual
 * conversion step, no distinct label to fall out of sync.
 *
 * Decision tree (first match wins):
 *   1. Stock (real trades OR a put that was ASSIGNED, which acquires shares
 *      with no separate stock-ledger entry) -> covered_call if currently
 *      >=100 shares OR a call has ever been sold against this ticker
 *      (covers a lot that's since been partially sold down but still has
 *      real short-call history/risk attached); otherwise -> stock (a
 *      sub-100-share lot can't have a call written against it yet)
 *   2. Short puts AND short calls -> strangle
 *   3. A long call leg (longTxns, kind 'C') at a DIFFERENT expiration than
 *      any short call -> diagonal (call PMCC)
 *   4. A long put leg (longTxns, kind 'P') at a DIFFERENT expiration than
 *      any short put -> put_diagonal (put calendar)
 *   5. Short call + long call IN THE SAME LEDGER (same expiration, i.e. a
 *      true vertical) -> credit_vertical or debit_vertical, calls
 *   6. Short put + long put in the same ledger -> credit_vertical or
 *      debit_vertical, puts
 *   7. Short puts only  -> strangle (one-legged: displays as "Short Put")
 *   8. Short calls only -> strangle (one-legged: displays as "Naked Call")
 *   9. Fallback -> covered_call (nothing at all yet — a freshly created position)
 *
 * A "same-expiration vertical" only exists in the call/put ledgers as
 * BTO/STC entries. Some importers (Schwab, tastytrade) route long legs into
 * the separate longTxns array by default, matching a diagonal's LEAPS-style
 * long leg — see promoteSameExpirationSpreads, which moves a ticker's
 * longTxns into the matching call/put ledger first when a long leg shares an
 * expiration with a short leg of the same kind (the tell for "this is
 * actually a same-week vertical, not a calendar/diagonal"). Everything past
 * that point is symmetric between calls and puts via the `kind` field on
 * each long leg (missing kind defaults to 'C' — every long leg predates
 * put diagonals existing, so it was always a call back then).
 *
 * Credit vs. debit is decided from the OPENING legs only (STO/BTO price *
 * contracts): a net credit at entry makes it a credit vertical, a net debit
 * makes it a debit vertical. Later rolls/closes don't change how it was
 * originally entered.
 */

import type { OptionTxnType, Strategy } from '../types';

// Structural shapes without `id` — satisfied by both a fresh CSV-import
// plan's id-less arrays and a saved Position's id-carrying ones.
interface StockLike {
  type: 'BUY' | 'SELL';
  date: string;
  shares: number;
  price: number;
  fees: number;
  note: string;
}
interface LongLike {
  type: 'BUY' | 'SELL';
  date: string;
  contracts: number;
  strike: number;
  expiration: string;
  price: number;
  fees: number;
  note: string;
  kind?: 'C' | 'P';
}
interface OptionLike {
  type: OptionTxnType;
  date: string;
  contracts: number;
  strike: number | null;
  expiration: string | null;
  price: number | null;
  fees: number;
  note: string;
}

export interface TxnShape {
  stockTxns: StockLike[];
  longTxns: LongLike[];
  callTxns: OptionLike[]; // "optionTxns" on a Position
  putTxns: OptionLike[];
}

export interface StrategyInferenceResult {
  strategy: Strategy;
  /** For credit_vertical/debit_vertical only: which ledger the vertical lives in. */
  optionKind: 'C' | 'P' | null;
  /** Set when the inference found something the label can't fully capture
   *  (e.g. a 4-leg structure) — surfaced as a warning, not blocking. */
  warning: string | null;
}

function hasSTO(txns: OptionLike[]): boolean {
  return txns.some((t) => t.type === 'STO');
}
function hasLongLeg(txns: OptionLike[]): boolean {
  return txns.some((t) => t.type === 'BTO' || t.type === 'STC');
}
function legKind(t: LongLike): 'C' | 'P' {
  return t.kind ?? 'C';
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a + 'T00:00:00').getTime() - new Date(b + 'T00:00:00').getTime()) / 86400000;
}

/** Do two transactions' date ranges ever actually coexist? Used to tell a
 *  real strangle (concurrent short put + short call) apart from two
 *  sequential, unrelated campaigns that happen to share a ticker (an old
 *  put vertical fully closed months before a new call diagonal even
 *  started) — see inferStrategy's strangle rule. */
function dateRangesOverlap(a: { date: string }[], b: { date: string }[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const aDates = a.map((t) => t.date).sort();
  const bDates = b.map((t) => t.date).sort();
  const [aStart, aEnd] = [aDates[0], aDates[aDates.length - 1]];
  const [bStart, bEnd] = [bDates[0], bDates[bDates.length - 1]];
  return aStart <= bEnd && bStart <= aEnd;
}

/** Net share count right now — buys/put-assignments add, sells/call-
 *  assignments subtract. Order doesn't matter for a final total (only for
 *  the running average cost, which this doesn't need), so this is a plain
 *  sum rather than a chronological walk. */
function currentSharesHeld(shape: TxnShape): number {
  let shares = 0;
  for (const t of shape.stockTxns) shares += t.type === 'BUY' ? t.shares : -t.shares;
  for (const t of shape.putTxns) if (t.type === 'ASSIGNED') shares += t.contracts * 100;
  for (const t of shape.callTxns) if (t.type === 'ASSIGNED') shares -= t.contracts * 100;
  return shares;
}

/** Net cash flow of just the opening legs (STO credit minus BTO cost, at
 *  entry price) — positive/zero means it was entered for a net credit. */
function verticalKind(shortLedgerTxns: OptionLike[]): 'credit_vertical' | 'debit_vertical' {
  const credit = shortLedgerTxns
    .filter((t) => t.type === 'STO')
    .reduce((s, t) => s + t.contracts * (t.price ?? 0), 0);
  const debit = shortLedgerTxns
    .filter((t) => t.type === 'BTO')
    .reduce((s, t) => s + t.contracts * (t.price ?? 0), 0);
  return credit >= debit ? 'credit_vertical' : 'debit_vertical';
}

export function inferStrategy(shape: TxnShape): StrategyInferenceResult {
  // A put assignment IS a stock acquisition even with no separate stockTxns
  // entry — the calc engine synthesizes the share purchase straight from the
  // ASSIGNED row (see walkWheelStockLeg), so a short put that gets assigned
  // with no prior manual stock trade would otherwise look stock-less here
  // and fall through to a strangle/vertical read of its option ledgers,
  // which is wrong — this is exactly the "short put converts to covered
  // call" moment. A call assignment alone does NOT imply stock — with no put
  // assignment or stock trade backing it, that's a strangle/vertical's short
  // leg getting exercised, not evidence of share ownership.
  const hasStock = shape.stockTxns.length > 0 || shape.putTxns.some((t) => t.type === 'ASSIGNED');
  const hasShortPuts = hasSTO(shape.putTxns);
  const hasShortCalls = hasSTO(shape.callTxns);
  const hasLongPutLeg = hasLongLeg(shape.putTxns);
  const hasLongCallLeg = hasLongLeg(shape.callTxns);

  if (hasStock) {
    // A call can't be written against fewer than 100 shares — a lot still
    // being built up toward a round lot, with no call sold against this
    // ticker yet, is just a stock holding. Once a call HAS been sold here,
    // it stays covered_call even if the lot later gets partially sold down
    // under 100 shares — that's real short-call history/risk, not a plain
    // stock position anymore.
    const strategy: Strategy = currentSharesHeld(shape) >= 100 || hasShortCalls ? 'covered_call' : 'stock';
    return { strategy, optionKind: null, warning: null };
  }

  // Both sides need to have actually coexisted in time to be one strangle —
  // not just "short puts happened at some point AND short calls happened at
  // some (possibly much later, unrelated) point." A put vertical that fully
  // closed months before a call diagonal even started is two sequential
  // campaigns on the same ticker, not a strangle; without this check the
  // diagonal below would get mislabeled strangle just because of that old,
  // dormant put history (and needsAttention would misleadingly suggest an
  // assignment happened, when it's really just this old data).
  if (hasShortPuts && hasShortCalls && dateRangesOverlap(shape.putTxns, shape.callTxns)) {
    const warning =
      hasLongPutLeg || hasLongCallLeg
        ? 'Has long option legs on top of the short strangle — this may actually be an iron condor/fly; only the strangle shape is tracked.'
        : null;
    return { strategy: 'strangle', optionKind: null, warning };
  }

  const longCallLegs = shape.longTxns.filter((t) => legKind(t) === 'C');
  const longPutLegs = shape.longTxns.filter((t) => legKind(t) === 'P');

  if (longCallLegs.length > 0 && longPutLegs.length > 0) {
    // Both kinds of long leg present and neither got promoted into a
    // same-expiration vertical — genuinely ambiguous (most likely two
    // blended campaigns on one ticker, e.g. an old put diagonal and a new
    // call diagonal). Pick a side so the label isn't left blank, and flag it.
    const strategy: Strategy = hasShortPuts && !hasShortCalls ? 'put_diagonal' : 'diagonal';
    return {
      strategy,
      optionKind: null,
      warning:
        'Has both a long call leg and a long put leg — this may be two blended campaigns; consider Split Position.',
    };
  }
  if (longCallLegs.length > 0) {
    return { strategy: 'diagonal', optionKind: null, warning: null };
  }
  if (longPutLegs.length > 0) {
    return { strategy: 'put_diagonal', optionKind: null, warning: null };
  }

  if (hasShortCalls && hasLongCallLeg) {
    return { strategy: verticalKind(shape.callTxns), optionKind: 'C', warning: null };
  }
  if (hasShortPuts && hasLongPutLeg) {
    return { strategy: verticalKind(shape.putTxns), optionKind: 'P', warning: null };
  }

  // A naked short put or short call with no stock, no long leg, and no
  // opposite-side short activity — the one-legged case of 'strangle'. Its
  // displayed name ("Short Put" / "Naked Call") is decided from the same
  // data by positionStrategyLabel; the underlying strategy value is the
  // same either way, so a lone short put reclassifies to 'covered_call'
  // automatically the instant it's assigned, with no separate wheel label
  // to fall out of sync in between.
  if (hasShortPuts || hasShortCalls) return { strategy: 'strangle', optionKind: null, warning: null };

  return { strategy: 'covered_call', optionKind: null, warning: null };
}

// A genuine same-week vertical is entered as one combined trade — the long
// and short legs opened within days of each other, not months apart. Beyond
// this window, a shared expiration is just coincidence (monthly option
// expirations recur constantly, so a long-dated diagonal anchor bought in
// March will often land on the same Friday as some unrelated short-call
// roll opened in July) rather than evidence the two were ever one trade.
const SAME_WEEK_VERTICAL_WINDOW_DAYS = 7;

/**
 * If a long leg shares an expiration with a short leg of the SAME kind
 * (call-with-call or put-with-put) AND the two were opened within days of
 * each other, it's really the long leg of a same-week vertical, not a
 * calendar/diagonal — move just that leg into the matching short ledger as
 * BTO/STC so inferStrategy reads it as a vertical. Per-leg, not per-ticker:
 * a ticker can genuinely run both a same-week vertical AND a separate
 * calendar/diagonal at different times, and moving every long leg just
 * because ONE happens to share an expiration with some unrelated short leg
 * (opened months apart) would corrupt the diagonal's own average-cost math.
 *
 * Calls and puts are handled independently (a long call is only ever
 * matched against short CALLS, a long put only against short PUTS), keyed
 * off the `kind` field — missing kind defaults to 'C', since every long leg
 * saved before put diagonals existed was always a call.
 *
 * `convert` builds the destination option-txn shape from a source long-txn
 * plus its new BTO/STC type — callers supply this since the plan shape
 * (no id) and the saved-position shape (needs a fresh id) differ.
 */
export function promoteSameExpirationSpreads<L extends LongLike, O extends OptionLike>(
  longTxns: L[],
  callTxns: O[],
  putTxns: O[],
  convert: (t: L, type: 'BTO' | 'STC') => O
): { longTxns: L[]; callTxns: O[]; putTxns: O[]; promoted: boolean } {
  if (longTxns.length === 0) {
    return { longTxns, callTxns, putTxns, promoted: false };
  }

  function promoteAgainst(subset: L[], shortLedger: O[]) {
    const shortOpens = shortLedger.filter((t) => t.type === 'STO');
    // A leg is identified by (strike, expiration) — its BUY and matching
    // SELL (if any) share both, so promoting by key moves the whole leg.
    const buys = subset.filter((t) => t.type === 'BUY');
    const promotedKeys = new Set(
      buys
        .filter((buy) =>
          shortOpens.some(
            (sto) => sto.expiration === buy.expiration && daysBetween(sto.date, buy.date) <= SAME_WEEK_VERTICAL_WINDOW_DAYS
          )
        )
        .map((buy) => `${buy.strike}|${buy.expiration}`)
    );
    const keyOf = (t: L) => `${t.strike}|${t.expiration}`;
    const toPromote = subset.filter((t) => promotedKeys.has(keyOf(t)));
    const remaining = subset.filter((t) => !promotedKeys.has(keyOf(t)));
    const converted = toPromote.map((t) => convert(t, t.type === 'BUY' ? 'BTO' : 'STC'));
    return { remaining, converted };
  }

  const longCalls = longTxns.filter((t) => legKind(t) === 'C');
  const longPuts = longTxns.filter((t) => legKind(t) === 'P');

  const callResult = promoteAgainst(longCalls, callTxns);
  const putResult = promoteAgainst(longPuts, putTxns);

  if (callResult.converted.length === 0 && putResult.converted.length === 0) {
    return { longTxns, callTxns, putTxns, promoted: false };
  }

  return {
    longTxns: [...callResult.remaining, ...putResult.remaining],
    callTxns: [...callTxns, ...callResult.converted],
    putTxns: [...putTxns, ...putResult.converted],
    promoted: true,
  };
}
