/*
 * positionSnapshot.ts — shared types + conversion logic for "positions
 * snapshot" imports (a broker's CURRENT positions/Greeks export, as opposed
 * to a transaction history). Two very different uses for the same data:
 *
 *   1. A ticker with no existing position → synthesize a starting
 *      transaction per leg (using the snapshot's own entry price) and hand
 *      it to the exact same `applyImport` pipeline the transaction-history
 *      importers use, so a new position quickly bootstraps with a rough
 *      state that can be corrected/filled in later (dates in particular are
 *      NOT real — a snapshot has no history, just where things stand now).
 *   2. A ticker that already has a position → never touch its transactions
 *      (that would double-count real history); just refresh its Pricing
 *      panel fields from the snapshot's mark prices, matched to whichever
 *      leg is actually still open.
 *
 * Pure module: no React/DOM.
 */
import type { LongTxn, OptionTxn, Position, StockTxn } from '../types';
import type { TickerPlan } from './schwabCsv';
import { emptyPlan, finalizePlans } from './schwabCsv';
import { todayStr } from './format';

export interface SnapshotLeg {
  kind: 'stock' | 'call' | 'put';
  qty: number; // signed: + long/held, - short
  strike: number | null; // null for stock
  expiration: string | null; // ISO date, null for stock
  mark: number; // current unsigned price/share (or /contract-share)
  tradePrice: number; // unsigned entry price/share this leg was opened at
}

export interface SnapshotTicker {
  ticker: string;
  account: string | null;
  legs: SnapshotLeg[];
}

export interface SnapshotImport {
  asOfDate: string | null; // ISO date the snapshot was taken, if known
  tickers: SnapshotTicker[];
}

/** Turns a snapshot ticker into a TickerPlan — for tickers with NO existing
 *  position, so the normal applyImport pipeline (strategy inference, naming,
 *  duplicate handling) can create it exactly like a CSV import would. Every
 *  synthesized transaction is dated `asOfDate` (today, if the file didn't
 *  carry one) and carries a note flagging it as an estimate, since the real
 *  entry date isn't known from a snapshot — only where things stand now. */
export function snapshotTickerToPlan(t: SnapshotTicker, asOfDate: string): TickerPlan {
  const plan = emptyPlan(t.ticker, t.account);
  const note = `Quick-added from a position snapshot (${asOfDate}) — entry date is a guess; strike/qty/price are real, verify and correct as needed.`;
  for (const leg of t.legs) {
    if (leg.qty === 0) continue;
    if (leg.kind === 'stock') {
      const stockTxn: Omit<StockTxn, 'id'> = {
        type: leg.qty > 0 ? 'BUY' : 'SELL',
        date: asOfDate,
        shares: Math.abs(leg.qty),
        price: leg.tradePrice,
        fees: 0,
        note,
      };
      plan.stockTxns.push(stockTxn);
      continue;
    }
    if (leg.strike == null || leg.expiration == null) continue; // malformed row — skip rather than guess
    if (leg.qty > 0) {
      // Long option leg — LongTxn ledger (used for diagonals/verticals' long side).
      const longTxn: Omit<LongTxn, 'id'> = {
        type: 'BUY',
        date: asOfDate,
        contracts: Math.abs(leg.qty),
        strike: leg.strike,
        expiration: leg.expiration,
        price: leg.tradePrice,
        fees: 0,
        note,
        kind: leg.kind === 'put' ? 'P' : 'C',
      };
      plan.longTxns.push(longTxn);
    } else {
      // Short option leg — the call or put ledger, same as a normal STO import row.
      const optionTxn: Omit<OptionTxn, 'id'> = {
        type: 'STO',
        date: asOfDate,
        contracts: Math.abs(leg.qty),
        strike: leg.strike,
        expiration: leg.expiration,
        price: leg.tradePrice,
        fees: 0,
        note,
      };
      if (leg.kind === 'put') plan.putTxns.push(optionTxn);
      else plan.callTxns.push(optionTxn);
    }
  }
  plan.firstDate = asOfDate;
  plan.lastDate = asOfDate;
  return plan;
}

/** Runs snapshotTickerToPlan + the same finalize pass (strategy inference,
 *  vertical promotion) the real importers use, for a whole batch. */
export function snapshotToPlans(snap: SnapshotImport): TickerPlan[] {
  const asOfDate = snap.asOfDate ?? todayStr();
  const map = new Map<string, TickerPlan>();
  for (const t of snap.tickers) {
    if (t.legs.every((l) => l.qty === 0)) continue; // fully flat — nothing to create
    map.set(`${t.ticker}|${t.account ?? ''}`, snapshotTickerToPlan(t, asOfDate));
  }
  return finalizePlans(map);
}

/** The reference (strike/expiration/kind) of whatever's currently open on
 *  each side of an existing position, so a snapshot's legs can be matched to
 *  the right Pricing-panel field. Scoped to the app's own 1-lot-at-a-time
 *  convention: "currently open" = the most recent opening transaction on
 *  that ledger that hasn't been fully closed, by running contract count. */
function openOptionRef(txns: OptionTxn[]): { strike: number; expiration: string } | null {
  let openQty = 0;
  let ref: { strike: number; expiration: string } | null = null;
  for (const t of [...txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    if (t.type === 'STO') {
      openQty += t.contracts;
      if (t.strike != null && t.expiration != null) ref = { strike: t.strike, expiration: t.expiration };
    } else if (t.type === 'BTC' || t.type === 'EXPIRED' || t.type === 'ASSIGNED') {
      openQty -= t.contracts;
    }
  }
  return openQty > 0 ? ref : null;
}

function openLongRef(txns: LongTxn[], kind: 'C' | 'P'): { strike: number; expiration: string } | null {
  let openQty = 0;
  let ref: { strike: number; expiration: string } | null = null;
  for (const t of [...txns].filter((t) => (t.kind ?? 'C') === kind).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    if (t.type === 'BUY') {
      openQty += t.contracts;
      ref = { strike: t.strike, expiration: t.expiration };
    } else {
      openQty -= t.contracts;
    }
  }
  return openQty > 0 ? ref : null;
}

function findLeg(legs: SnapshotLeg[], kind: SnapshotLeg['kind'], ref: { strike: number; expiration: string } | null): SnapshotLeg | null {
  if (!ref) return null;
  return legs.find((l) => l.kind === kind && l.strike === ref.strike && l.expiration === ref.expiration) ?? null;
}

/** Maps a matched snapshot ticker's legs onto the Pricing-panel fields of an
 *  EXISTING position, by finding whichever leg is actually still open on
 *  each side and pulling its mark price — never touches transactions. */
export function snapshotToPricingUpdate(
  position: Position,
  snapshotTicker: SnapshotTicker
): Partial<Pick<Position, 'currentPrice' | 'currentLongValue' | 'currentShortValue' | 'currentPutValue'>> {
  const legs = snapshotTicker.legs;
  const update: Partial<Pick<Position, 'currentPrice' | 'currentLongValue' | 'currentShortValue' | 'currentPutValue'>> = {};

  switch (position.strategy) {
    case 'stock':
    case 'covered_call': {
      const stockLeg = legs.find((l) => l.kind === 'stock');
      if (stockLeg) update.currentPrice = stockLeg.mark;
      const shortCall = findLeg(legs, 'call', openOptionRef(position.optionTxns));
      if (shortCall) update.currentShortValue = shortCall.mark;
      const shortPut = findLeg(legs, 'put', openOptionRef(position.putTxns));
      if (shortPut) update.currentPutValue = shortPut.mark;
      break;
    }
    case 'diagonal':
    case 'put_diagonal': {
      const kind = position.strategy === 'put_diagonal' ? 'P' : 'C';
      const longRef = openLongRef(position.longTxns, kind);
      const longLeg = findLeg(legs, kind === 'P' ? 'put' : 'call', longRef);
      if (longLeg) update.currentLongValue = longLeg.mark;
      const shortLedger = kind === 'P' ? position.putTxns : position.optionTxns;
      const shortLeg = findLeg(legs, kind === 'P' ? 'put' : 'call', openOptionRef(shortLedger));
      if (shortLeg) update.currentShortValue = shortLeg.mark;
      break;
    }
    case 'credit_vertical':
    case 'debit_vertical': {
      // Whichever ledger actually has the transactions is the vertical's kind
      // (mirrors calc.ts's own majority-rule heuristic).
      const kind: 'C' | 'P' = position.putTxns.length > position.optionTxns.length ? 'P' : 'C';
      const shortLedger = kind === 'P' ? position.putTxns : position.optionTxns;
      const shortLeg = findLeg(legs, kind === 'P' ? 'put' : 'call', openOptionRef(shortLedger));
      if (shortLeg) update.currentShortValue = shortLeg.mark;
      const longRef = openLongRef(position.longTxns, kind);
      const longLeg = findLeg(legs, kind === 'P' ? 'put' : 'call', longRef);
      if (longLeg) update.currentLongValue = longLeg.mark;
      break;
    }
    case 'strangle': {
      const shortCall = findLeg(legs, 'call', openOptionRef(position.optionTxns));
      if (shortCall) update.currentShortValue = shortCall.mark;
      const shortPut = findLeg(legs, 'put', openOptionRef(position.putTxns));
      if (shortPut) update.currentPutValue = shortPut.mark;
      break;
    }
  }
  return update;
}
