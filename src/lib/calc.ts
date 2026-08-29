/*
 * calc.ts — pure calculation engine for cost-basis / breakeven tracking.
 * No React, no DOM — safe to unit test in isolation.
 *
 * MODEL (trading break-even view, not IRS tax-lot accounting):
 *
 *   Covered call position = stock lots (BUY/SELL, or acquired via a put
 *   assignment) + a short-call ledger (STO / BTC / EXPIRED / ASSIGNED),
 *   possibly spanning many rolls over time — plus, optionally, a short-put
 *   ledger from before/alongside (there's no separate "wheel" strategy; a
 *   naked short put converts to this the instant it's assigned).
 *
 *   Diagonal position = a long leg (BUY/SELL, acting as the stock substitute)
 *   + a short leg of the same kind at a different expiration — 'diagonal' for
 *   calls (PMCC), 'put_diagonal' for puts (calendar).
 *
 * Stock (or long-call) cost basis is tracked with the AVERAGE COST method:
 * each buy blends into a running weighted-average price; each sell/assignment
 * removes shares (or contracts) at that running average, leaving the average
 * unchanged. This is standard for a "what's my breakeven right now" view —
 * it is not FIFO tax-lot accounting.
 *
 * Net option premium collected = sum of all STO inflows minus all BTC
 * outflows (fees included), for every short-call transaction ever entered
 * against the position, including every leg of every roll. EXPIRED entries
 * have no cash flow (the premium was already booked at STO). ASSIGNED
 * entries close the obligation with no *additional* premium — the strike
 * proceeds are stock-sale proceeds, not premium, and are booked separately.
 *
 *   effective cost basis per share = avg stock cost  -  (net premium collected / shares held)
 *   breakeven price                = effective cost basis per share
 *
 * Realized P&L, once a position is fully closed (zero shares/contracts
 * held), is simply: total cash in − total cash out, over the position's
 * entire lifetime. That sidesteps lot-matching entirely and is always
 * correct as a bottom-line number.
 *
 * Unrealized P&L, while still open, additionally marks any still-open
 * short calls to their current market value (a liability until closed).
 */

import type {
  CostBasisHistoryRow,
  CoveredCallMetrics,
  DiagonalMetrics,
  LongTxn,
  OptionTxn,
  Position,
  PositionMetrics,
  SpreadMetrics,
  StockTxn,
  StrangleMetrics,
} from '../types';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

interface Pool {
  qty: number;
  avg: number;
}

// Consume `qty` units from an average-cost pool (shares or contracts).
// Returns the cost removed from the pool; pool.avg is unchanged (that's
// the point of average-cost accounting), pool.qty decreases.
function consumeFromPool(pool: Pool, qty: number): number {
  const costRemoved = qty * pool.avg;
  pool.qty = round2(pool.qty - qty);
  return costRemoved;
}

function addToPool(pool: Pool, qty: number, totalCost: number): void {
  const newQty = pool.qty + qty;
  const newTotalCost = pool.qty * pool.avg + totalCost;
  pool.qty = round2(newQty);
  pool.avg = newQty > 0 ? newTotalCost / newQty : 0;
}

function sortByDate<T extends { date: string }>(txns: T[]): T[] {
  return [...txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Sort stock-pool events chronologically, and within the same date process
 * share-ACQUIRING events before share-DISPOSING ones. Assignments post on
 * the same date as their follow-on trades (e.g. put assigned and the shares
 * sold the same day); selling first would drain an empty pool.
 */
function sortStockEvents<T extends { date: string }>(events: T[], rankOf: (e: T) => number): T[] {
  return [...events].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : rankOf(a) - rankOf(b)
  );
}

/** Same idea, for a diagonal's long leg (units = contracts, not shares).
 *  Takes the array directly (not a Position) so callers can pass a
 *  kind-filtered subset — a position's longTxns can hold both a call-kind
 *  and a put-kind leg (e.g. a stray leg left behind by reclassification). */
function walkLongLeg(longTxns: LongTxn[]) {
  const pool: Pool = { qty: 0, avg: 0 }; // avg = $ per CONTRACT (already includes the x100 multiplier)
  let longCashFlow = 0;
  const events = sortByDate(longTxns || []);
  for (const ev of events) {
    if (ev.type === 'BUY') {
      const cost = ev.contracts * ev.price * 100 + (ev.fees || 0);
      addToPool(pool, ev.contracts, cost);
      longCashFlow -= cost;
    } else if (ev.type === 'SELL') {
      const contracts = Math.min(ev.contracts, pool.qty);
      consumeFromPool(pool, contracts);
      const proceeds = ev.contracts * ev.price * 100 - (ev.fees || 0);
      longCashFlow += proceeds;
    }
  }
  return { pool, longCashFlow };
}

/**
 * Walk an option ledger (short calls or short puts, plus any BTO/STC long
 * legs from spreads). Returns net premium cash flow and open counts.
 * Open counts are clamped at 0: a close whose opening trade predates the
 * imported history would otherwise drive them negative and wedge the
 * position permanently "open".
 */
function walkShortLeg(optionTxnsSorted: OptionTxn[]) {
  let openContracts = 0; // short interest
  let openLongContracts = 0; // long interest (spread hedge legs)
  let premiumNet = 0; // all STO/BTC/BTO/STC cash
  let assignmentProceeds = 0; // ASSIGNED strike proceeds
  let lastExpiration: string | null = null;

  for (const t of optionTxnsSorted) {
    if (t.type === 'STO') {
      premiumNet += t.contracts * (t.price ?? 0) * 100 - (t.fees || 0);
      openContracts += t.contracts;
      lastExpiration = t.expiration;
    } else if (t.type === 'BTC') {
      premiumNet -= t.contracts * (t.price ?? 0) * 100 + (t.fees || 0);
      openContracts -= t.contracts;
    } else if (t.type === 'BTO') {
      premiumNet -= t.contracts * (t.price ?? 0) * 100 + (t.fees || 0);
      openLongContracts += t.contracts;
    } else if (t.type === 'STC') {
      premiumNet += t.contracts * (t.price ?? 0) * 100 - (t.fees || 0);
      openLongContracts -= t.contracts;
    } else if (t.type === 'EXPIRED') {
      openContracts -= t.contracts;
    } else if (t.type === 'ASSIGNED') {
      openContracts -= t.contracts;
      assignmentProceeds += t.contracts * (t.strike ?? 0) * 100 - (t.fees || 0);
    }
  }
  return {
    openContracts: Math.max(0, round2(openContracts)),
    openLongContracts: Math.max(0, round2(openLongContracts)),
    premiumNet,
    assignmentProceeds,
    lastExpiration,
  };
}

/**
 * Walk an option ledger with NO stock (or long-call) pool behind it — used
 * by spread and strangle, neither of which own shares. ASSIGNED is folded
 * directly into cash flow instead of being routed into a stock purchase/sale
 * the way covered_call/wheel do it, since there's no share inventory here:
 * a put assignment books the cash cost of buying at the strike, a call
 * assignment books the cash value of selling at the strike — the same sign
 * convention the ledger UI already uses per-row (see OptionLedgerPanel's
 * rowCashFlow). EXPIRED always closes a SHORT contract, by convention: a
 * long leg expiring is entered as STC at price 0 (see OptionTxnType doc).
 */
function walkCashLeg(txnsSorted: OptionTxn[], leg: 'put' | 'call') {
  let cashFlow = 0;
  let openShort = 0;
  let openLong = 0;
  let lastExpiration: string | null = null;
  let hadAssignment = false;

  for (const t of txnsSorted) {
    if (t.type === 'STO') {
      cashFlow += t.contracts * (t.price ?? 0) * 100 - (t.fees || 0);
      openShort += t.contracts;
      lastExpiration = t.expiration;
    } else if (t.type === 'BTC') {
      cashFlow -= t.contracts * (t.price ?? 0) * 100 + (t.fees || 0);
      openShort -= t.contracts;
    } else if (t.type === 'BTO') {
      cashFlow -= t.contracts * (t.price ?? 0) * 100 + (t.fees || 0);
      openLong += t.contracts;
      if (!lastExpiration) lastExpiration = t.expiration;
    } else if (t.type === 'STC') {
      cashFlow += t.contracts * (t.price ?? 0) * 100 - (t.fees || 0);
      openLong -= t.contracts;
    } else if (t.type === 'EXPIRED') {
      openShort -= t.contracts;
    } else if (t.type === 'ASSIGNED') {
      openShort -= t.contracts;
      hadAssignment = true;
      const gross = t.contracts * (t.strike ?? 0) * 100;
      cashFlow += leg === 'put' ? -(gross + (t.fees || 0)) : gross - (t.fees || 0);
    }
  }
  return {
    cashFlow,
    openShort: Math.max(0, round2(openShort)),
    openLong: Math.max(0, round2(openLong)),
    lastExpiration,
    hadAssignment,
  };
}

/**
 * Wheel stock walker: merges stock BUY/SELL txns with put-ASSIGNED events
 * (shares bought at the put strike) and call-ASSIGNED events (shares called
 * away at the call strike), all in chronological order.
 */
function walkWheelStockLeg(
  position: Position,
  callTxnsSorted: OptionTxn[],
  putTxnsSorted: OptionTxn[]
) {
  const pool: Pool = { qty: 0, avg: 0 };
  let stockCashFlow = 0;

  type WheelEvent =
    | (StockTxn & { _src: 'stock' })
    | (OptionTxn & { _src: 'call_assigned' })
    | (OptionTxn & { _src: 'put_assigned' });

  const events: WheelEvent[] = [
    ...sortByDate(position.stockTxns || []).map((t): WheelEvent => ({ ...t, _src: 'stock' })),
    ...callTxnsSorted
      .filter((t) => t.type === 'ASSIGNED')
      .map((t): WheelEvent => ({ ...t, _src: 'call_assigned' })),
    ...putTxnsSorted
      .filter((t) => t.type === 'ASSIGNED')
      .map((t): WheelEvent => ({ ...t, _src: 'put_assigned' })),
  ];

  const acquiring = (e: WheelEvent) =>
    e._src === 'put_assigned' || (e._src === 'stock' && e.type === 'BUY') ? 0 : 1;

  for (const ev of sortStockEvents(events, acquiring)) {
    if (ev._src === 'stock' && ev.type === 'BUY') {
      const cost = ev.shares * ev.price + (ev.fees || 0);
      addToPool(pool, ev.shares, cost);
      stockCashFlow -= cost;
    } else if (ev._src === 'stock' && ev.type === 'SELL') {
      const shares = Math.min(ev.shares, pool.qty);
      consumeFromPool(pool, shares);
      stockCashFlow += ev.shares * ev.price - (ev.fees || 0);
    } else if (ev._src === 'put_assigned') {
      // Assigned on a short put: we BUY shares at the strike.
      const shares = ev.contracts * 100;
      const cost = shares * (ev.strike ?? 0) + (ev.fees || 0);
      addToPool(pool, shares, cost);
      stockCashFlow -= cost;
    } else if (ev._src === 'call_assigned') {
      // Assigned on a short call: shares are called away at the strike.
      const sharesCalled = ev.contracts * 100;
      const shares = Math.min(sharesCalled, pool.qty);
      consumeFromPool(pool, shares);
      stockCashFlow += sharesCalled * (ev.strike ?? 0) - (ev.fees || 0);
    }
  }

  return { pool, stockCashFlow };
}

type Ledger = 'stock' | 'long' | 'call' | 'put';

/**
 * Every strategy branch below reads a specific subset of the four ledgers
 * as its "primary" data (e.g. covered_call reads stock+call; strangle reads
 * put+call). A position can still carry data in a ledger outside that set —
 * most commonly because it was reclassified away from a strategy that DID
 * use that ledger (e.g. wheel, which folds in a stray long-call leg; move
 * a ticker to covered_call or strangle and that leg would otherwise vanish
 * from the P&L silently). This walks whatever ledgers aren't already
 * "primary" and returns their combined cash flow plus whether anything in
 * them is still open — which must block `fullyClosed` even if every
 * primary ledger is flat, or realizedPL would overstate a position that
 * still has money at risk in an untracked leg.
 *
 * Stock is deliberately excluded here: every strategy that can legitimately
 * hold stock (covered_call, wheel) already walks it as primary, so a stray
 * stock ledger would only appear from manual data entry gone wrong — safer
 * to leave it visible/uncounted than to guess at its average cost here.
 */
function strayLedgerImpact(position: Position, primary: Set<Ledger>) {
  let cashFlow = 0;
  let stillOpen = false;
  let hasAny = false;

  if (!primary.has('long') && (position.longTxns || []).length > 0) {
    hasAny = true;
    const { pool, longCashFlow } = walkLongLeg(position.longTxns || []);
    cashFlow += longCashFlow;
    if (pool.qty > 0) stillOpen = true;
  }
  if (!primary.has('call') && (position.optionTxns || []).length > 0) {
    hasAny = true;
    const leg = walkCashLeg(sortByDate(position.optionTxns || []), 'call');
    cashFlow += leg.cashFlow;
    if (leg.openShort > 0 || leg.openLong > 0) stillOpen = true;
  }
  if (!primary.has('put') && (position.putTxns || []).length > 0) {
    hasAny = true;
    const leg = walkCashLeg(sortByDate(position.putTxns || []), 'put');
    cashFlow += leg.cashFlow;
    if (leg.openShort > 0 || leg.openLong > 0) stillOpen = true;
  }

  return { cashFlow, stillOpen, hasAny };
}

export function computePositionMetrics(position: Position): PositionMetrics {
  const optionTxnsSorted = sortByDate(position.optionTxns || []);
  const shortLeg = walkShortLeg(optionTxnsSorted);

  if (position.strategy === 'covered_call' || position.strategy === 'stock') {
    // Owns stock (bought outright, or acquired via a put assignment).
    // 'stock' vs 'covered_call' is purely a label difference (a sub-100-share
    // lot with no call history yet, vs one that can or does have calls sold
    // against it) — this is the same branch formerly split into
    // "covered_call" and "wheel" too; there's no meaningful math difference
    // between any of them. A plain stock/covered call (never sold a put)
    // just carries zeros for the put fields.
    const putTxnsSorted = sortByDate(position.putTxns || []);
    const putLeg = walkShortLeg(putTxnsSorted);
    const { pool, stockCashFlow } = walkWheelStockLeg(position, optionTxnsSorted, putTxnsSorted);
    // Long-call leg too: imported positions can carry call calendars
    // (e.g. GOOGL put verticals + call calendars in one ticker) as a stray.
    const longLeg = walkLongLeg(position.longTxns || []);

    const sharesHeld = round2(pool.qty);
    const avgStockCost = pool.avg;
    const stockCostBasisTotal = round2(sharesHeld * avgStockCost);
    const netPutPremium = round2(putLeg.premiumNet);
    const netCallPremium = round2(shortLeg.premiumNet);
    const netPremiumCollected = round2(netPutPremium + netCallPremium);

    // "Open" while anything is live: shares, short or long options on either leg.
    const hasTxns =
      (position.stockTxns || []).length > 0 ||
      (position.longTxns || []).length > 0 ||
      optionTxnsSorted.length > 0 ||
      putTxnsSorted.length > 0;
    const isOpen =
      sharesHeld > 0 ||
      putLeg.openContracts > 0 ||
      putLeg.openLongContracts > 0 ||
      shortLeg.openContracts > 0 ||
      shortLeg.openLongContracts > 0 ||
      longLeg.pool.qty > 0;
    const fullyClosed = !isOpen && hasTxns;

    let effectiveCostBasisPerShare: number | null = null;
    let breakevenPrice: number | null = null;
    let effectiveCostBasisTotal: number | null = null;
    if (sharesHeld > 0) {
      effectiveCostBasisTotal = round2(stockCostBasisTotal - netPremiumCollected);
      effectiveCostBasisPerShare = round2(effectiveCostBasisTotal / sharesHeld);
      breakevenPrice = effectiveCostBasisPerShare;
    }

    // Assignment cash flows (both directions) live in stockCashFlow; premium
    // ledgers are pure open/close trades, so this sum never double-counts.
    const totalCashFlow = round2(stockCashFlow + netCallPremium + netPutPremium + longLeg.longCashFlow);
    const realizedPL = fullyClosed ? totalCashFlow : null;

    // Unrealized needs a mark for whichever leg dominates: the stock price
    // once shares are held, or a put mark during a pure-CSP phase (e.g. a
    // manual override forced 'covered_call' before any shares showed up).
    const hasNeededMark =
      sharesHeld > 0 ? position.currentPrice != null : position.currentPutValue != null;
    let unrealizedPL: number | null = null;
    if (isOpen && hasNeededMark) {
      const callLiability =
        shortLeg.openContracts > 0 && position.currentShortValue != null
          ? shortLeg.openContracts * 100 * position.currentShortValue
          : 0;
      const putLiability =
        putLeg.openContracts > 0 && position.currentPutValue != null
          ? putLeg.openContracts * 100 * position.currentPutValue
          : 0;
      const stockGain =
        sharesHeld > 0 && position.currentPrice != null
          ? (position.currentPrice - avgStockCost) * sharesHeld
          : 0;
      unrealizedPL = round2(stockGain + netPremiumCollected - callLiability - putLiability);
    }

    const lastExpiration =
      [shortLeg.lastExpiration, putLeg.lastExpiration].filter(Boolean).sort().pop() ?? null;

    const metrics: CoveredCallMetrics = {
      strategy: position.strategy,
      isOpen,
      sharesHeld,
      avgStockCost: round2(avgStockCost),
      stockCostBasisTotal,
      netPutPremium,
      netCallPremium,
      netPremiumCollected,
      effectiveCostBasisPerShare,
      breakevenPrice,
      effectiveCostBasisTotal,
      openShortPuts: putLeg.openContracts,
      openShortContracts: shortLeg.openContracts,
      lastExpiration,
      realizedPL,
      unrealizedPL,
      fullyClosed,
      needsAttention: (position.longTxns || []).length > 0,
    };
    return metrics;
  }

  if (position.strategy === 'credit_vertical' || position.strategy === 'debit_vertical') {
    const putTxnsSorted = sortByDate(position.putTxns || []);
    // Whichever ledger actually holds the data — majority rule, defaulting
    // to calls on a tie (including a brand-new position with nothing yet).
    const optionKind: 'C' | 'P' = putTxnsSorted.length > optionTxnsSorted.length ? 'P' : 'C';
    const txns = optionKind === 'P' ? putTxnsSorted : optionTxnsSorted;
    const leg = walkCashLeg(txns, optionKind === 'P' ? 'put' : 'call');
    const stray = strayLedgerImpact(position, new Set<Ledger>([optionKind === 'P' ? 'put' : 'call']));

    const isOpen = leg.openShort > 0 || leg.openLong > 0 || stray.stillOpen;
    const fullyClosed = !isOpen && (txns.length > 0 || stray.hasAny);
    const netPremiumCollected = round2(leg.cashFlow);
    const realizedPL = fullyClosed ? round2(leg.cashFlow + stray.cashFlow) : null;

    let unrealizedPL: number | null = null;
    if (leg.openShort > 0 || leg.openLong > 0) {
      const needShortMark = leg.openShort > 0;
      const needLongMark = leg.openLong > 0;
      const hasShortMark = !needShortMark || position.currentShortValue != null;
      const hasLongMark = !needLongMark || position.currentLongValue != null;
      if (hasShortMark && hasLongMark) {
        const shortLiability = needShortMark ? leg.openShort * 100 * (position.currentShortValue as number) : 0;
        const longValue = needLongMark ? leg.openLong * 100 * (position.currentLongValue as number) : 0;
        unrealizedPL = round2(netPremiumCollected - shortLiability + longValue);
      }
    }

    const metrics: SpreadMetrics = {
      strategy: position.strategy,
      optionKind,
      isOpen,
      openShortContracts: leg.openShort,
      openLongContracts: leg.openLong,
      netPremiumCollected,
      lastExpiration: leg.lastExpiration,
      realizedPL,
      unrealizedPL,
      fullyClosed,
      needsAttention: leg.hadAssignment || stray.hasAny,
    };
    return metrics;
  }

  if (position.strategy === 'strangle') {
    const putTxnsSorted = sortByDate(position.putTxns || []);
    const putLeg = walkCashLeg(putTxnsSorted, 'put');
    const callLeg = walkCashLeg(optionTxnsSorted, 'call');
    const stray = strayLedgerImpact(position, new Set<Ledger>(['call', 'put']));

    const hasTxns = putTxnsSorted.length > 0 || optionTxnsSorted.length > 0 || stray.hasAny;
    const isOpen =
      putLeg.openShort > 0 || putLeg.openLong > 0 || callLeg.openShort > 0 || callLeg.openLong > 0 || stray.stillOpen;
    const fullyClosed = !isOpen && hasTxns;
    const netPutPremium = round2(putLeg.cashFlow);
    const netCallPremium = round2(callLeg.cashFlow);
    const netPremiumCollected = round2(netPutPremium + netCallPremium);
    const realizedPL = fullyClosed ? round2(netPremiumCollected + stray.cashFlow) : null;

    let unrealizedPL: number | null = null;
    if (!stray.stillOpen && (putLeg.openShort > 0 || putLeg.openLong > 0 || callLeg.openShort > 0 || callLeg.openLong > 0)) {
      // Long legs here would mean this is really a 4-leg structure (iron
      // condor/fly) — needsAttention/warnings already flag that case at
      // import time; we just decline to guess an unrealized mark for it.
      const hasUnmarkableLongLegs = putLeg.openLong > 0 || callLeg.openLong > 0;
      const needPutMark = putLeg.openShort > 0;
      const needCallMark = callLeg.openShort > 0;
      const hasPutMark = !needPutMark || position.currentPutValue != null;
      const hasCallMark = !needCallMark || position.currentShortValue != null;
      if (!hasUnmarkableLongLegs && hasPutMark && hasCallMark) {
        const putLiability = needPutMark ? putLeg.openShort * 100 * (position.currentPutValue as number) : 0;
        const callLiability = needCallMark ? callLeg.openShort * 100 * (position.currentShortValue as number) : 0;
        unrealizedPL = round2(netPremiumCollected - putLiability - callLiability);
      }
    }

    const lastExpiration =
      [putLeg.lastExpiration, callLeg.lastExpiration].filter(Boolean).sort().pop() ?? null;

    const metrics: StrangleMetrics = {
      strategy: 'strangle',
      isOpen,
      openShortPuts: putLeg.openShort,
      openShortCalls: callLeg.openShort,
      netPutPremium,
      netCallPremium,
      netPremiumCollected,
      lastExpiration,
      realizedPL,
      unrealizedPL,
      fullyClosed,
      needsAttention: putLeg.hadAssignment || callLeg.hadAssignment || stray.hasAny,
    };
    return metrics;
  }

  // diagonal (call PMCC) / put_diagonal (put calendar) — identical math,
  // mirrored across which ledger holds the short leg (calls vs puts) and
  // which kind of long leg backs it. A position's longTxns can in principle
  // hold both kinds (e.g. two blended campaigns), so kind is checked
  // per-transaction rather than assumed from the strategy label alone.
  const isPutDiagonal = position.strategy === 'put_diagonal';
  const diagKind: 'C' | 'P' = isPutDiagonal ? 'P' : 'C';
  const diagShortTxnsSorted = isPutDiagonal ? sortByDate(position.putTxns || []) : optionTxnsSorted;
  const diagShortLedgerTxns = isPutDiagonal ? position.putTxns || [] : position.optionTxns || [];
  const diagShortLeg = isPutDiagonal ? walkShortLeg(diagShortTxnsSorted) : shortLeg;

  const allLong = position.longTxns || [];
  const primaryLong = allLong.filter((t) => (t.kind ?? 'C') === diagKind);
  const otherLong = allLong.filter((t) => (t.kind ?? 'C') !== diagKind);

  const { pool, longCashFlow } = walkLongLeg(primaryLong);
  const openLongContracts = round2(pool.qty);
  const avgLongCostPerContract = pool.avg; // $ per contract (already x100)
  const avgLongCost = avgLongCostPerContract / 100; // $ per share, for display/comparison to quotes
  const longCostBasisTotal = round2(openLongContracts * avgLongCostPerContract);
  const netPremiumCollected = round2(diagShortLeg.premiumNet);

  const stray = strayLedgerImpact(position, new Set<Ledger>(['long', isPutDiagonal ? 'put' : 'call']));
  if (otherLong.length > 0) {
    // A long leg of the OTHER kind sitting in the same longTxns array (e.g. a
    // stray put-diagonal leg left behind on what's now a call diagonal) —
    // same treatment as any other stray ledger: fold its cash flow in and
    // force needsAttention rather than silently dropping it.
    const otherLeg = walkLongLeg(otherLong);
    stray.cashFlow += otherLeg.longCashFlow;
    stray.hasAny = true;
    if (otherLeg.pool.qty > 0) stray.stillOpen = true;
  }

  const isOpen =
    openLongContracts > 0 || diagShortLeg.openContracts > 0 || diagShortLeg.openLongContracts > 0 || stray.stillOpen;
  let effectiveCostBasisPerContract: number | null = null;
  let effectiveCostBasisTotal: number | null = null;
  if (openLongContracts > 0) {
    effectiveCostBasisTotal = round2(longCostBasisTotal - netPremiumCollected);
    effectiveCostBasisPerContract = round2(effectiveCostBasisTotal / openLongContracts);
  }

  const fullyClosed = !isOpen && (allLong.length > 0 || diagShortLedgerTxns.length > 0 || stray.hasAny);
  const totalCashFlow = round2(
    longCashFlow + diagShortLeg.premiumNet + diagShortLeg.assignmentProceeds + stray.cashFlow
  );
  const realizedPL = fullyClosed ? totalCashFlow : null;

  let unrealizedPL: number | null = null;
  if (openLongContracts > 0 && position.currentLongValue != null) {
    const shortLiability =
      diagShortLeg.openContracts > 0 && position.currentShortValue != null
        ? diagShortLeg.openContracts * 100 * position.currentShortValue
        : 0;
    unrealizedPL = round2(
      (position.currentLongValue - avgLongCost) * openLongContracts * 100 +
        netPremiumCollected -
        shortLiability
    );
  }

  const metrics: DiagonalMetrics = {
    strategy: isPutDiagonal ? 'put_diagonal' : 'diagonal',
    isOpen,
    openLongContracts,
    avgLongCost: round2(avgLongCost),
    longCostBasisTotal,
    netPremiumCollected,
    effectiveCostBasisPerContract,
    effectiveCostBasisTotal,
    openShortContracts: diagShortLeg.openContracts,
    assignmentProceedsPending: diagShortLeg.openContracts === 0 ? diagShortLeg.assignmentProceeds : null,
    lastExpiration: diagShortLeg.lastExpiration,
    realizedPL,
    unrealizedPL,
    fullyClosed,
    needsAttention:
      (diagShortLeg.assignmentProceeds !== 0 &&
        openLongContracts > 0 &&
        diagShortLedgerTxns.some((t) => t.type === 'ASSIGNED')) ||
      stray.hasAny,
  };
  return metrics;
}

/**
 * The running story behind a covered_call/stock/diagonal/put_diagonal
 * position's effective basis — the same `avg cost - cumulative premium /
 * qty` formula computePositionMetrics uses for the final snapshot, captured
 * at every event instead of only at the end. One row per raw transaction
 * (not paired into "rolls") — an STO ticks the basis down the moment
 * premium is collected, a BTC ticks it back up a bit, matching how the cash
 * actually moves rather than an artificial pairing that gets ambiguous the
 * moment a roll is partial or multi-contract. Returns [] for strategies with
 * no basis concept (vertical, strangle).
 */
export function computeCostBasisHistory(position: Position): CostBasisHistoryRow[] {
  if (position.strategy === 'stock' || position.strategy === 'covered_call') {
    return coveredCallHistory(position);
  }
  if (position.strategy === 'diagonal' || position.strategy === 'put_diagonal') {
    return diagonalHistory(position, position.strategy === 'put_diagonal' ? 'P' : 'C');
  }
  return [];
}

type CCHistoryEvent =
  | { src: 'stock'; txn: StockTxn }
  | { src: 'put'; txn: OptionTxn }
  | { src: 'call'; txn: OptionTxn };

function coveredCallHistory(position: Position): CostBasisHistoryRow[] {
  const events: CCHistoryEvent[] = [
    ...(position.stockTxns || []).map((t): CCHistoryEvent => ({ src: 'stock', txn: t })),
    ...(position.putTxns || []).map((t): CCHistoryEvent => ({ src: 'put', txn: t })),
    ...(position.optionTxns || []).map((t): CCHistoryEvent => ({ src: 'call', txn: t })),
  ];
  // Same acquiring-before-disposing same-day tie-break walkWheelStockLeg uses.
  const rankOf = (e: CCHistoryEvent) =>
    (e.src === 'stock' && e.txn.type === 'BUY') || (e.src === 'put' && e.txn.type === 'ASSIGNED') ? 0 : 1;
  const sorted = [...events].sort((a, b) =>
    a.txn.date < b.txn.date ? -1 : a.txn.date > b.txn.date ? 1 : rankOf(a) - rankOf(b)
  );

  const pool: Pool = { qty: 0, avg: 0 };
  let cumulativePremium = 0;
  const rows: CostBasisHistoryRow[] = [];

  for (const ev of sorted) {
    let cashFlow = 0;
    let event: string;

    if (ev.src === 'stock' && ev.txn.type === 'BUY') {
      const cost = ev.txn.shares * ev.txn.price + (ev.txn.fees || 0);
      addToPool(pool, ev.txn.shares, cost);
      cashFlow = -cost;
      event = `Bought ${ev.txn.shares} sh @ $${ev.txn.price.toFixed(2)}`;
    } else if (ev.src === 'stock' && ev.txn.type === 'SELL') {
      consumeFromPool(pool, Math.min(ev.txn.shares, pool.qty));
      cashFlow = ev.txn.shares * ev.txn.price - (ev.txn.fees || 0);
      event = `Sold ${ev.txn.shares} sh @ $${ev.txn.price.toFixed(2)}`;
    } else if (ev.src === 'put' && ev.txn.type === 'ASSIGNED') {
      const shares = ev.txn.contracts * 100;
      const cost = shares * (ev.txn.strike ?? 0) + (ev.txn.fees || 0);
      addToPool(pool, shares, cost);
      cashFlow = -cost;
      event = `Assigned — bought ${shares} sh ($${ev.txn.strike ?? '—'} strike, exp ${ev.txn.expiration ?? '—'})`;
    } else if (ev.src === 'call' && ev.txn.type === 'ASSIGNED') {
      const sharesCalled = ev.txn.contracts * 100;
      consumeFromPool(pool, Math.min(sharesCalled, pool.qty));
      cashFlow = sharesCalled * (ev.txn.strike ?? 0) - (ev.txn.fees || 0);
      event = `Assigned — ${sharesCalled} sh called away ($${ev.txn.strike ?? '—'} strike, exp ${ev.txn.expiration ?? '—'})`;
    } else if (ev.src !== 'stock' && ev.txn.type === 'STO') {
      cashFlow = ev.txn.contracts * (ev.txn.price ?? 0) * 100 - (ev.txn.fees || 0);
      cumulativePremium += cashFlow;
      event = `Sold to open ${ev.txn.contracts} ${ev.src} @ $${(ev.txn.price ?? 0).toFixed(2)} ($${ev.txn.strike ?? '—'} strike, exp ${ev.txn.expiration ?? '—'})`;
    } else if (ev.src !== 'stock' && ev.txn.type === 'BTC') {
      cashFlow = -(ev.txn.contracts * (ev.txn.price ?? 0) * 100 + (ev.txn.fees || 0));
      cumulativePremium += cashFlow;
      event = `Bought to close ${ev.txn.contracts} ${ev.src} @ $${(ev.txn.price ?? 0).toFixed(2)} ($${ev.txn.strike ?? '—'} strike, exp ${ev.txn.expiration ?? '—'})`;
    } else if (ev.src !== 'stock' && ev.txn.type === 'EXPIRED') {
      event = `${ev.src === 'put' ? 'Put' : 'Call'} expired worthless ($${ev.txn.strike ?? '—'} strike, exp ${ev.txn.expiration ?? '—'})`;
    } else {
      continue; // BTO/STC don't occur here (vertical-only) — skip defensively
    }

    const basis = pool.qty > 0 ? round2(pool.avg - cumulativePremium / pool.qty) : null;
    rows.push({ date: ev.txn.date, event, cashFlow: round2(cashFlow), cumulativePremium: round2(cumulativePremium), basis });
  }
  return rows;
}

type DiagHistoryEvent = { src: 'long'; txn: LongTxn } | { src: 'short'; txn: OptionTxn };

function diagonalHistory(position: Position, kind: 'C' | 'P'): CostBasisHistoryRow[] {
  const primaryLong = (position.longTxns || []).filter((t) => (t.kind ?? 'C') === kind);
  const shortLedger = kind === 'C' ? position.optionTxns || [] : position.putTxns || [];
  const legWord = kind === 'P' ? 'put' : 'call';

  const events: DiagHistoryEvent[] = [
    ...primaryLong.map((t): DiagHistoryEvent => ({ src: 'long', txn: t })),
    ...shortLedger.map((t): DiagHistoryEvent => ({ src: 'short', txn: t })),
  ];
  // Buying the long leg ranks first on a tied date — you acquire it before
  // a short leg can be sold against it.
  const rankOf = (e: DiagHistoryEvent) => (e.src === 'long' && e.txn.type === 'BUY' ? 0 : 1);
  const sorted = [...events].sort((a, b) =>
    a.txn.date < b.txn.date ? -1 : a.txn.date > b.txn.date ? 1 : rankOf(a) - rankOf(b)
  );

  const pool: Pool = { qty: 0, avg: 0 }; // avg = $/contract (x100), matching walkLongLeg
  let cumulativePremium = 0;
  const rows: CostBasisHistoryRow[] = [];

  for (const ev of sorted) {
    let cashFlow = 0;
    let event: string;

    if (ev.src === 'long' && ev.txn.type === 'BUY') {
      const cost = ev.txn.contracts * ev.txn.price * 100 + (ev.txn.fees || 0);
      addToPool(pool, ev.txn.contracts, cost);
      cashFlow = -cost;
      event = `Bought ${ev.txn.contracts} long ${legWord}, $${ev.txn.strike} strike, exp ${ev.txn.expiration}, @ $${ev.txn.price.toFixed(2)}`;
    } else if (ev.src === 'long' && ev.txn.type === 'SELL') {
      consumeFromPool(pool, Math.min(ev.txn.contracts, pool.qty));
      cashFlow = ev.txn.contracts * ev.txn.price * 100 - (ev.txn.fees || 0);
      event = `Sold to close the long ${legWord} @ $${ev.txn.price.toFixed(2)} ($${ev.txn.strike ?? '—'} strike, exp ${ev.txn.expiration ?? '—'})`;
    } else if (ev.src === 'short' && ev.txn.type === 'STO') {
      cashFlow = ev.txn.contracts * (ev.txn.price ?? 0) * 100 - (ev.txn.fees || 0);
      cumulativePremium += cashFlow;
      event = `Sold to open ${ev.txn.contracts} short ${legWord} @ $${(ev.txn.price ?? 0).toFixed(2)} ($${ev.txn.strike ?? '—'} strike, exp ${ev.txn.expiration ?? '—'})`;
    } else if (ev.src === 'short' && ev.txn.type === 'BTC') {
      cashFlow = -(ev.txn.contracts * (ev.txn.price ?? 0) * 100 + (ev.txn.fees || 0));
      cumulativePremium += cashFlow;
      event = `Bought to close ${ev.txn.contracts} short ${legWord} @ $${(ev.txn.price ?? 0).toFixed(2)} ($${ev.txn.strike ?? '—'} strike, exp ${ev.txn.expiration ?? '—'})`;
    } else if (ev.src === 'short' && ev.txn.type === 'EXPIRED') {
      event = `Expired worthless ($${ev.txn.strike ?? '—'} strike, exp ${ev.txn.expiration ?? '—'})`;
    } else if (ev.src === 'short' && ev.txn.type === 'ASSIGNED') {
      // No stock to receive the assignment — the strike proceeds sit pending
      // until the long leg is manually resolved (see assignmentProceedsPending).
      event = `Assigned ($${ev.txn.strike ?? '—'} strike, exp ${ev.txn.expiration ?? '—'}) — resolve the long leg manually`;
    } else {
      continue; // BTO/STC don't occur here (vertical-only) — skip defensively
    }

    const basis = pool.qty > 0 ? round2(pool.avg / 100 - cumulativePremium / (pool.qty * 100)) : null;
    rows.push({ date: ev.txn.date, event, cashFlow: round2(cashFlow), cumulativePremium: round2(cumulativePremium), basis });
  }
  return rows;
}

/**
 * How much profit is already locked in — booked from completed round trips
 * — even while the position as a whole is still open. A diagonal or covered
 * call can carry real, already-realized gains from short-leg rolls that
 * have each individually closed (STO+BTC, or expired), while the position
 * itself stays open because the long leg (or the stock) hasn't been sold.
 * `realizedPL` stays null the whole time that's true — see
 * computePositionMetrics, which only sets it once EVERY leg is closed —
 * this is the piece that's already banked before that happens.
 *
 * Formula: take the position's all-time net cash flow, then cancel out the
 * two pieces that are still "at risk" rather than realized — add back the
 * cost basis of whatever's still held (that money isn't lost, just parked
 * in an open position) and subtract the premium collected by whatever short
 * contract is still open (that premium isn't safe until it's closed). What's
 * left is cash flow belonging entirely to transactions that have already
 * fully round-tripped. For a fully closed position this reduces to the same
 * number as realizedPL (nothing left "at risk" to cancel out). Returns null
 * for strategies with no basis concept (vertical, strangle) or no txns yet.
 */
export function computeLockedInProfit(position: Position): number | null {
  if (position.strategy === 'stock' || position.strategy === 'covered_call') {
    return coveredCallLockedIn(position);
  }
  if (position.strategy === 'diagonal' || position.strategy === 'put_diagonal') {
    return diagonalLockedIn(position, position.strategy === 'put_diagonal' ? 'P' : 'C');
  }
  return null;
}

function coveredCallLockedIn(position: Position): number | null {
  const hasTxns =
    (position.stockTxns?.length ?? 0) + (position.putTxns?.length ?? 0) + (position.optionTxns?.length ?? 0) > 0;
  if (!hasTxns) return null;

  const events: CCHistoryEvent[] = [
    ...(position.stockTxns || []).map((t): CCHistoryEvent => ({ src: 'stock', txn: t })),
    ...(position.putTxns || []).map((t): CCHistoryEvent => ({ src: 'put', txn: t })),
    ...(position.optionTxns || []).map((t): CCHistoryEvent => ({ src: 'call', txn: t })),
  ];
  // Unlike coveredCallHistory's plain 0/1 rank, a same-day roll (BTC the old
  // strike, STO a new one) needs the close to land in the premium pool
  // BEFORE the reopen — otherwise avg-cost pooling blends the old and new
  // contracts' premium together for the instant they're both "in" the pool,
  // corrupting the average attributed to what's still actually open.
  const rankOf = (e: CCHistoryEvent) => {
    if ((e.src === 'stock' && e.txn.type === 'BUY') || (e.src === 'put' && e.txn.type === 'ASSIGNED')) return 0;
    if (e.src !== 'stock' && e.txn.type === 'STO') return 2;
    return 1;
  };
  const sorted = [...events].sort((a, b) =>
    a.txn.date < b.txn.date ? -1 : a.txn.date > b.txn.date ? 1 : rankOf(a) - rankOf(b)
  );

  // Same shape as coveredCallHistory's cost-basis pool, plus one more pool
  // per option ledger tracking the average PREMIUM (rather than cost) still
  // tied up in whatever's currently open on that ledger.
  const stockPool: Pool = { qty: 0, avg: 0 };
  const putPremiumPool: Pool = { qty: 0, avg: 0 };
  const callPremiumPool: Pool = { qty: 0, avg: 0 };
  let cashFlow = 0;

  for (const ev of sorted) {
    if (ev.src === 'stock' && ev.txn.type === 'BUY') {
      const cost = ev.txn.shares * ev.txn.price + (ev.txn.fees || 0);
      addToPool(stockPool, ev.txn.shares, cost);
      cashFlow -= cost;
    } else if (ev.src === 'stock' && ev.txn.type === 'SELL') {
      consumeFromPool(stockPool, Math.min(ev.txn.shares, stockPool.qty));
      cashFlow += ev.txn.shares * ev.txn.price - (ev.txn.fees || 0);
    } else if (ev.src === 'put' && ev.txn.type === 'ASSIGNED') {
      const shares = ev.txn.contracts * 100;
      const cost = shares * (ev.txn.strike ?? 0) + (ev.txn.fees || 0);
      addToPool(stockPool, shares, cost);
      cashFlow -= cost;
      consumeFromPool(putPremiumPool, Math.min(ev.txn.contracts, putPremiumPool.qty));
    } else if (ev.src === 'call' && ev.txn.type === 'ASSIGNED') {
      const sharesCalled = ev.txn.contracts * 100;
      consumeFromPool(stockPool, Math.min(sharesCalled, stockPool.qty));
      cashFlow += sharesCalled * (ev.txn.strike ?? 0) - (ev.txn.fees || 0);
      consumeFromPool(callPremiumPool, Math.min(ev.txn.contracts, callPremiumPool.qty));
    } else if (ev.src !== 'stock' && ev.txn.type === 'STO') {
      const premium = ev.txn.contracts * (ev.txn.price ?? 0) * 100 - (ev.txn.fees || 0);
      cashFlow += premium;
      addToPool(ev.src === 'put' ? putPremiumPool : callPremiumPool, ev.txn.contracts, premium);
    } else if (ev.src !== 'stock' && ev.txn.type === 'BTC') {
      cashFlow -= ev.txn.contracts * (ev.txn.price ?? 0) * 100 + (ev.txn.fees || 0);
      const pool = ev.src === 'put' ? putPremiumPool : callPremiumPool;
      consumeFromPool(pool, Math.min(ev.txn.contracts, pool.qty));
    } else if (ev.src !== 'stock' && ev.txn.type === 'EXPIRED') {
      const pool = ev.src === 'put' ? putPremiumPool : callPremiumPool;
      consumeFromPool(pool, Math.min(ev.txn.contracts, pool.qty));
    }
    // BTO/STC don't occur here (vertical-only) — skip defensively, same as coveredCallHistory
  }

  const stillOpenCost = round2(stockPool.qty * stockPool.avg);
  const stillOpenPutPremium = round2(putPremiumPool.qty * putPremiumPool.avg);
  const stillOpenCallPremium = round2(callPremiumPool.qty * callPremiumPool.avg);
  return round2(cashFlow + stillOpenCost - stillOpenPutPremium - stillOpenCallPremium);
}

function diagonalLockedIn(position: Position, kind: 'C' | 'P'): number | null {
  const primaryLong = (position.longTxns || []).filter((t) => (t.kind ?? 'C') === kind);
  const shortLedger = kind === 'C' ? position.optionTxns || [] : position.putTxns || [];
  if (primaryLong.length + shortLedger.length === 0) return null;

  const events: DiagHistoryEvent[] = [
    ...primaryLong.map((t): DiagHistoryEvent => ({ src: 'long', txn: t })),
    ...shortLedger.map((t): DiagHistoryEvent => ({ src: 'short', txn: t })),
  ];
  // Same reasoning as coveredCallLockedIn's rankOf: a same-day roll (BTC the
  // old strike, STO a new one) must close before it reopens, or the
  // avg-cost premium pool blends the two contracts together.
  const rankOf = (e: DiagHistoryEvent) => {
    if (e.src === 'long' && e.txn.type === 'BUY') return 0;
    if (e.src === 'short' && e.txn.type === 'STO') return 2;
    return 1;
  };
  const sorted = [...events].sort((a, b) =>
    a.txn.date < b.txn.date ? -1 : a.txn.date > b.txn.date ? 1 : rankOf(a) - rankOf(b)
  );

  const longPool: Pool = { qty: 0, avg: 0 };
  const shortPremiumPool: Pool = { qty: 0, avg: 0 };
  let cashFlow = 0;

  for (const ev of sorted) {
    if (ev.src === 'long' && ev.txn.type === 'BUY') {
      const cost = ev.txn.contracts * ev.txn.price * 100 + (ev.txn.fees || 0);
      addToPool(longPool, ev.txn.contracts, cost);
      cashFlow -= cost;
    } else if (ev.src === 'long' && ev.txn.type === 'SELL') {
      consumeFromPool(longPool, Math.min(ev.txn.contracts, longPool.qty));
      cashFlow += ev.txn.contracts * ev.txn.price * 100 - (ev.txn.fees || 0);
    } else if (ev.src === 'short' && ev.txn.type === 'STO') {
      const premium = ev.txn.contracts * (ev.txn.price ?? 0) * 100 - (ev.txn.fees || 0);
      cashFlow += premium;
      addToPool(shortPremiumPool, ev.txn.contracts, premium);
    } else if (ev.src === 'short' && ev.txn.type === 'BTC') {
      cashFlow -= ev.txn.contracts * (ev.txn.price ?? 0) * 100 + (ev.txn.fees || 0);
      consumeFromPool(shortPremiumPool, Math.min(ev.txn.contracts, shortPremiumPool.qty));
    } else if (ev.src === 'short' && ev.txn.type === 'EXPIRED') {
      consumeFromPool(shortPremiumPool, Math.min(ev.txn.contracts, shortPremiumPool.qty));
    } else if (ev.src === 'short' && ev.txn.type === 'ASSIGNED') {
      // No stock to receive it — matches diagonalHistory's ASSIGNED handling:
      // the strike proceeds book as cash flow immediately even though the
      // long leg still needs manual resolution.
      cashFlow += ev.txn.contracts * (ev.txn.strike ?? 0) * 100 - (ev.txn.fees || 0);
      consumeFromPool(shortPremiumPool, Math.min(ev.txn.contracts, shortPremiumPool.qty));
    }
    // BTO/STC don't occur here (vertical-only) — skip defensively
  }

  const stillOpenLongCost = round2(longPool.qty * longPool.avg);
  const stillOpenShortPremium = round2(shortPremiumPool.qty * shortPremiumPool.avg);
  return round2(cashFlow + stillOpenLongCost - stillOpenShortPremium);
}

export { round2 };
