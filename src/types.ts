export type Strategy =
  | 'stock' // owns shares, but fewer than 100 and has never sold a call against them — a call can't be written on a partial lot, so this isn't a covered call yet
  | 'covered_call' // owns >=100 shares (however acquired — bought outright or via put assignment), OR has ever sold a call against this ticker even if share count later dipped under 100; may also carry short-put history from before/alongside — no separate 'wheel' label, it just becomes this the moment shares show up
  | 'diagonal' // call diagonal (PMCC): long call + short call, different expirations
  | 'put_diagonal' // put diagonal (calendar): long put + short put, different expirations
  | 'credit_vertical' // short + long, same kind, SAME expiration, opened for a net credit
  | 'debit_vertical' // short + long, same kind, SAME expiration, opened for a net debit
  | 'strangle'; // naked short option(s), no stock — one leg (short put or naked call) or both (a true strangle); see positionStrategyLabel for the data-dependent display name

export interface StockTxn {
  id: string;
  type: 'BUY' | 'SELL';
  date: string;
  shares: number;
  price: number;
  fees: number;
  note: string;
}

export interface LongTxn {
  id: string;
  type: 'BUY' | 'SELL';
  date: string;
  contracts: number;
  strike: number;
  expiration: string;
  price: number; // $ per share (standard option quoting)
  fees: number;
  note: string;
  /** Call or put leg. Optional for backward compatibility with data saved
   *  before put diagonals existed — every long leg back then was a call, so
   *  a missing kind always means 'C'. */
  kind?: 'C' | 'P';
}

/**
 * STO/BTC open and close a SHORT contract; BTO/STC open and close a LONG
 * contract in the same ledger (used for the protective legs of spreads —
 * e.g. the long 395P in a 395/400 put credit spread). EXPIRED/ASSIGNED
 * close shorts. A long leg that expires is recorded as STC at price 0.
 */
export type OptionTxnType = 'STO' | 'BTC' | 'EXPIRED' | 'ASSIGNED' | 'BTO' | 'STC';

export interface OptionTxn {
  id: string;
  type: OptionTxnType;
  date: string;
  contracts: number;
  strike: number | null;
  expiration: string | null;
  price: number | null; // $ per share; only meaningful for STO/BTC
  fees: number;
  note: string;
}

export interface Position {
  id: string;
  ticker: string;
  strategy: Strategy;
  /** True once the user has explicitly picked `strategy` from the dropdown.
   *  Auto-reclassification (on load, on import merge, and the bulk
   *  "Reclassify Strategies" button) skips any position with this set, so a
   *  deliberate override survives new transactions coming in. */
  strategyOverride?: boolean;
  /** Display name — "TICKER — Strategy (start date)" by default, so two
   *  positions sharing a ticker (after a Split, or two campaigns run
   *  separately from the start) are actually distinguishable in the
   *  dashboard list and in the CSV-import merge-target picker. Auto-
   *  generated and kept in sync on every reclassify pass (ticker, strategy,
   *  or earliest transaction date can all change it) unless `nameOverride`
   *  is set — same pattern as `strategyOverride`. Optional for backward
   *  compatibility with positions saved before naming existed; treat a
   *  missing name as "not yet auto-named" rather than a blank name. */
  name?: string;
  /** True once the user has explicitly edited `name`. Freezes auto-naming
   *  the same way `strategyOverride` freezes auto-classification. */
  nameOverride?: boolean;
  /** Broker/account tag (e.g. "Schwab", "tastytrade"). Same ticker at two
   *  brokers stays two positions; null = manually created. */
  account?: string | null;
  notes: string;
  createdDate: string;
  stockTxns: StockTxn[];
  longTxns: LongTxn[];
  optionTxns: OptionTxn[]; // short CALL ledger
  putTxns: OptionTxn[]; // short PUT ledger
  currentPrice: number | null; // covered_call: underlying stock price
  currentLongValue: number | null; // diagonal: long call value, $/share
  currentShortValue: number | null; // open short call value, $/share
  currentPutValue: number | null; // open short put value, $/share
}

/**
 * Derived metrics for a stock-holding position — owns stock (bought outright
 * or acquired via a put assignment). `strategy` says whether a call could be
 * written against it yet: 'stock' for a sub-100-share lot with no call
 * history, 'covered_call' once it's >=100 shares or has ever had a call sold
 * against it. Also carries any short-put activity that happened
 * before/alongside (folded in the same way a "wheel" traditionally would
 * be): a plain covered call just shows zeros for the put fields, no
 * separate strategy needed.
 */
export interface CoveredCallMetrics {
  strategy: 'stock' | 'covered_call';
  isOpen: boolean;
  sharesHeld: number;
  avgStockCost: number;
  stockCostBasisTotal: number;
  netPutPremium: number;
  netCallPremium: number;
  netPremiumCollected: number; // netPutPremium + netCallPremium
  effectiveCostBasisPerShare: number | null;
  breakevenPrice: number | null;
  effectiveCostBasisTotal: number | null;
  openShortPuts: number;
  openShortContracts: number; // open short CALLS (name kept parallel to other strategies)
  lastExpiration: string | null;
  realizedPL: number | null;
  unrealizedPL: number | null;
  fullyClosed: boolean;
  /** True if a stray long-option leg (left behind by reclassification) has
   *  data folded into the math but no panel showing it. */
  needsAttention: boolean;
}

/** Derived metrics for a diagonal position — a long leg (LEAPS-style) plus a
 *  short leg of the same kind at a different expiration. `strategy` says
 *  which kind backs it: 'diagonal' = call diagonal (PMCC), 'put_diagonal' =
 *  put diagonal (calendar). Same math either way — only the label differs. */
export interface DiagonalMetrics {
  strategy: 'diagonal' | 'put_diagonal';
  isOpen: boolean;
  openLongContracts: number;
  avgLongCost: number; // $ per share
  longCostBasisTotal: number;
  netPremiumCollected: number;
  effectiveCostBasisPerContract: number | null;
  effectiveCostBasisTotal: number | null;
  openShortContracts: number;
  assignmentProceedsPending: number | null;
  lastExpiration: string | null;
  realizedPL: number | null;
  unrealizedPL: number | null;
  fullyClosed: boolean;
  needsAttention: boolean;
}

/**
 * Derived metrics for a vertical (short + long leg, same option kind, SAME
 * expiration — e.g. a 305/315 put credit spread). `strategy` says whether it
 * was opened for a net credit or a net debit; `optionKind` says which ledger
 * (putTxns or optionTxns) holds it. Both are derived from the transactions,
 * not stored independently. Same-kind legs at DIFFERENT expirations are a
 * diagonal/put_diagonal instead, not a vertical.
 */
export interface SpreadMetrics {
  strategy: 'credit_vertical' | 'debit_vertical';
  optionKind: 'C' | 'P';
  isOpen: boolean;
  openShortContracts: number;
  openLongContracts: number;
  netPremiumCollected: number; // running cash flow: positive = net credit banked so far
  lastExpiration: string | null;
  realizedPL: number | null;
  unrealizedPL: number | null;
  fullyClosed: boolean;
  needsAttention: boolean; // a leg was assigned — no stock ledger to route it into
}

/**
 * Derived metrics for naked short option(s) with no stock behind them — one
 * leg (a lone short put, or a lone naked call) or both (a true strangle).
 * Cash-flow only, no share inventory. `strategy` is always 'strangle'; the
 * displayed name depends on which leg(s) actually have activity — see
 * positionStrategyLabel in PositionDetail.tsx ("Short Put" / "Naked Call" /
 * "Strangle"). The moment stock shows up (e.g. a short put gets assigned),
 * the position becomes 'covered_call' instead — there's no manual
 * conversion step.
 */
export interface StrangleMetrics {
  strategy: 'strangle';
  isOpen: boolean;
  openShortPuts: number;
  openShortCalls: number;
  netPutPremium: number;
  netCallPremium: number;
  netPremiumCollected: number;
  lastExpiration: string | null;
  realizedPL: number | null;
  unrealizedPL: number | null;
  fullyClosed: boolean;
  needsAttention: boolean; // a leg was assigned — no stock ledger to route it into
}

export type PositionMetrics = CoveredCallMetrics | DiagonalMetrics | SpreadMetrics | StrangleMetrics;

/**
 * One row of a cost-basis history — the running story of how a covered
 * call's (or diagonal's) effective basis has moved as premium got collected.
 * Only meaningful for stock/covered_call (basis per share) and
 * diagonal/put_diagonal (basis per share-equivalent, matching avgLongCost's
 * convention) — verticals and strangles have no basis concept.
 */
export interface CostBasisHistoryRow {
  date: string;
  event: string; // plain-English description of what happened
  cashFlow: number;
  cumulativePremium: number;
  /** Effective cost basis per share (or per share-equivalent for a
   *  diagonal's long leg) as of this event. Null once nothing is held
   *  anymore (fully closed). */
  basis: number | null;
}
