/*
 * schwabCsv.ts — parser for Schwab transaction-history CSV exports
 * (Accounts → History → Export on Schwab.com; same format from thinkorswim's
 * Schwab-hosted history page).
 *
 * Expected shape (header line may be preceded by a title line):
 *
 *   "Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
 *   "04/07/2025","Sell to Open","PLTR 04/11/2025 83.00 P","PUT ...","1","$9.02","$0.66","$901.34"
 *   "03/21/2025","Buy","AAPL","APPLE INC","100","$150.00","$0.00","-$15000.00"
 *
 * Option symbols look like "TICKER MM/DD/YYYY STRIKE C|P". Non-trade rows
 * (dividends, journals, transfers, interest) are ignored. "Expired" and
 * "Assigned" rows don't say whether the contract was short or long, so we
 * replay rows chronologically and keep a running open-contract count per
 * contract to resolve them.
 *
 * Pure module: no React, no DOM — unit-testable in isolation.
 */

import type { LongTxn, OptionTxn, StockTxn, Strategy } from '../types';
import { inferStrategy, promoteSameExpirationSpreads } from './strategyInference';

export interface TickerPlan {
  ticker: string;
  strategy: Strategy; // inferred; user can override in the preview UI
  account: string | null; // broker tag ("Schwab", "tastytrade")
  stockTxns: Omit<StockTxn, 'id'>[];
  longTxns: Omit<LongTxn, 'id'>[];
  callTxns: Omit<OptionTxn, 'id'>[];
  putTxns: Omit<OptionTxn, 'id'>[];
  firstDate: string | null;
  lastDate: string | null;
  warnings: string[];
}

/** Blank plan for a ticker; shared by all broker parsers. */
export function emptyPlan(ticker: string, account: string | null): TickerPlan {
  return {
    ticker,
    strategy: 'covered_call',
    account,
    stockTxns: [],
    longTxns: [],
    callTxns: [],
    putTxns: [],
    firstDate: null,
    lastDate: null,
    warnings: [],
  };
}

/** Shared final pass: drop empty plans, promote same-expiration verticals
 *  out of the diagonal ledger, infer strategy, add warnings, sort. */
export function finalizePlans(plans: Map<string, TickerPlan>): TickerPlan[] {
  for (const [ticker, p] of plans) {
    if (p.stockTxns.length + p.longTxns.length + p.callTxns.length + p.putTxns.length === 0) {
      plans.delete(ticker);
    }
  }
  for (const p of plans.values()) {
    const promoted = promoteSameExpirationSpreads(p.longTxns, p.callTxns, p.putTxns, (t, type) => ({
      ...t,
      type,
    }));
    p.longTxns = promoted.longTxns;
    p.callTxns = promoted.callTxns;
    p.putTxns = promoted.putTxns;

    const inferred = inferStrategy(p);
    p.strategy = inferred.strategy;
    if (inferred.warning) p.warnings.push(inferred.warning);

    if ((p.strategy === 'covered_call' || p.strategy === 'stock') && p.longTxns.length > 0) {
      p.warnings.push('Also has long-option trades; they count in the P&L math but the covered call view has no panel for them.');
    }
    if ((p.strategy === 'diagonal' || p.strategy === 'put_diagonal') && p.stockTxns.length > 0) {
      p.warnings.push('Has stock trades too; the diagonal view will not display them.');
    }
  }
  return [...plans.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export interface SkippedRow {
  line: number; // 1-based line number in the file
  reason: string;
  raw: string;
}

export interface ParsedImport {
  plans: TickerPlan[];
  skipped: SkippedRow[];
  ignoredCount: number; // recognized non-trade rows (dividends etc.)
  totalDataRows: number;
}

// ---------- CSV tokenizing ----------

/** Minimal RFC-4180-ish CSV parser: quoted fields, embedded commas/quotes/newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------- field parsing helpers ----------

export function parseMoney(s: string | undefined): number {
  if (!s) return 0;
  const cleaned = s.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseQty(s: string | undefined): number {
  const n = Math.abs(parseMoney(s));
  return Number.isFinite(n) ? n : 0;
}

/** First MM/DD/YYYY in the field → YYYY-MM-DD (handles "06/20/2025 as of 06/19/2025"). */
function parseDate(s: string | undefined): string | null {
  const m = s?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

interface OptionSymbol {
  ticker: string;
  expiration: string; // YYYY-MM-DD
  strike: number;
  kind: 'C' | 'P';
}

function parseOptionSymbol(symbol: string): OptionSymbol | null {
  const m = symbol.trim().match(/^([A-Za-z.\-/]+)\s+(\d{2}\/\d{2}\/\d{4})\s+([\d.]+)\s+([CP])$/i);
  if (!m) return null;
  return {
    ticker: m[1].toUpperCase(),
    expiration: parseDate(m[2])!,
    strike: parseFloat(m[3]),
    kind: m[4].toUpperCase() as 'C' | 'P',
  };
}

// Non-trade actions we recognize and silently ignore.
const IGNORED_ACTIONS = new Set(
  [
    'journal', 'moneylink transfer', 'moneylink deposit', 'wire received', 'wire sent',
    'cash dividend', 'qualified dividend', 'non-qualified div', 'special dividend',
    'special qual div', 'pr yr cash div', 'reinvest shares', 'reinvest dividend',
    'bank interest', 'credit interest', 'margin interest', 'service fee',
    'misc cash entry', 'stock split', 'reverse split', 'journaled shares',
    'internal transfer', 'funds received', 'funds paid', 'security transfer',
    'mandatory reorg exc', 'cash in lieu', 'foreign tax paid', 'adr mgmt fee',
    'nra tax adj', 'stock plan activity', 'futures mm sweep',
  ].map((s) => s.toLowerCase())
);

// Fallback for ignorable actions we haven't seen the exact name of: anything
// clearly cash-movement / corporate-action shaped, never a trade.
const IGNORED_PATTERNS = /dividend|interest|sweep|split|transfer|journal|reorg|spin[- ]?off|tax|fee|reinvest/i;

// ---------- main mapper ----------

interface RawRow {
  line: number;
  date: string;
  action: string;
  symbol: string;
  quantity: number; // absolute
  signedQty: number; // as exported — on "Expired" rows, negative means a LONG contract expired
  price: number;
  fees: number;
  raw: string;
}

export function parseSchwabCsv(text: string): ParsedImport {
  const rows = parseCsv(text);
  const skipped: SkippedRow[] = [];
  let ignoredCount = 0;

  // Locate the header row.
  const headerIdx = rows.findIndex(
    (r) =>
      r.some((c) => c.trim().toLowerCase() === 'date') &&
      r.some((c) => c.trim().toLowerCase() === 'action') &&
      r.some((c) => c.trim().toLowerCase() === 'symbol')
  );
  if (headerIdx === -1) {
    throw new Error(
      'Could not find a Schwab header row ("Date","Action","Symbol",...). Is this a transaction-history export?'
    );
  }
  const header = rows[headerIdx].map((c) => c.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iDate = col('date');
  const iAction = col('action');
  const iSymbol = col('symbol');
  const iQty = col('quantity');
  const iPrice = col('price');
  const iFees = col('fees & comm');

  const dataRows: RawRow[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.every((c) => c.trim() === '')) continue;
    const rawLine = cells.join(',');
    const action = (cells[iAction] ?? '').trim();
    const date = parseDate(cells[iDate]);
    if (!action && !date) continue; // footer/disclaimer lines
    if (!date) {
      skipped.push({ line: r + 1, reason: 'No parseable date', raw: rawLine });
      continue;
    }
    dataRows.push({
      line: r + 1,
      date,
      action,
      symbol: (cells[iSymbol] ?? '').trim(),
      quantity: parseQty(cells[iQty]),
      signedQty: parseMoney(cells[iQty]),
      price: iPrice >= 0 ? parseMoney(cells[iPrice]) : 0,
      fees: iFees >= 0 ? parseMoney(cells[iFees]) : 0,
      raw: rawLine,
    });
  }

  // Chronological replay (Schwab exports newest-first). Stable sort keeps
  // same-day rows in reverse file order, which is chronological order.
  const chronological = [...dataRows].reverse().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const plans = new Map<string, TickerPlan>();
  const getPlan = (ticker: string): TickerPlan => {
    let p = plans.get(ticker);
    if (!p) {
      p = emptyPlan(ticker, 'Schwab');
      plans.set(ticker, p);
    }
    return p;
  };
  const touchDates = (p: TickerPlan, date: string) => {
    if (!p.firstDate || date < p.firstDate) p.firstDate = date;
    if (!p.lastDate || date > p.lastDate) p.lastDate = date;
  };

  // Running open-contract counts per exact contract, to classify Expired/Assigned.
  const openShort = new Map<string, number>(); // key: ticker|exp|strike|kind
  const openLong = new Map<string, number>();
  const keyOf = (o: OptionSymbol) => `${o.ticker}|${o.expiration}|${o.strike}|${o.kind}`;
  const bump = (m: Map<string, number>, k: string, d: number) => m.set(k, (m.get(k) ?? 0) + d);

  for (const row of chronological) {
    const action = row.action.toLowerCase();

    if (IGNORED_ACTIONS.has(action)) {
      ignoredCount++;
      continue;
    }

    const opt = parseOptionSymbol(row.symbol);

    // ----- stock rows -----
    if ((action === 'buy' || action === 'sell') && !opt) {
      const ticker = row.symbol.toUpperCase();
      if (!ticker) {
        skipped.push({ line: row.line, reason: `No symbol on "${row.action}" row`, raw: row.raw });
        continue;
      }
      const p = getPlan(ticker);
      p.stockTxns.push({
        type: action === 'buy' ? 'BUY' : 'SELL',
        date: row.date,
        shares: row.quantity,
        price: row.price,
        fees: row.fees,
        note: 'Imported from Schwab CSV',
      });
      touchDates(p, row.date);
      continue;
    }

    // ----- option rows -----
    if (!opt) {
      if (IGNORED_PATTERNS.test(row.action)) {
        ignoredCount++;
      } else {
        skipped.push({ line: row.line, reason: `Unrecognized action "${row.action}" or symbol format`, raw: row.raw });
      }
      continue;
    }

    const p = getPlan(opt.ticker);
    const k = keyOf(opt);
    const shortLedger = opt.kind === 'C' ? p.callTxns : p.putTxns;
    const base = {
      date: row.date,
      contracts: row.quantity,
      strike: opt.strike,
      expiration: opt.expiration,
      fees: row.fees,
      note: 'Imported from Schwab CSV',
    };

    if (action === 'sell to open') {
      shortLedger.push({ ...base, type: 'STO', price: row.price });
      bump(openShort, k, row.quantity);
    } else if (action === 'buy to close') {
      shortLedger.push({ ...base, type: 'BTC', price: row.price });
      bump(openShort, k, -row.quantity);
    } else if (action === 'buy to open') {
      // Long leg — defaults into the diagonal/calendar ledger regardless of
      // call or put; promoteSameExpirationSpreads moves it into the matching
      // short ledger afterward if its expiration turns out to match a short
      // leg of the same kind (same-week vertical, not a calendar/diagonal).
      p.longTxns.push({
        type: 'BUY', date: row.date, contracts: row.quantity, strike: opt.strike,
        expiration: opt.expiration, price: row.price, fees: row.fees, note: 'Imported from Schwab CSV',
        kind: opt.kind,
      });
      bump(openLong, k, row.quantity);
    } else if (action === 'sell to close') {
      p.longTxns.push({
        type: 'SELL', date: row.date, contracts: row.quantity, strike: opt.strike,
        expiration: opt.expiration, price: row.price, fees: row.fees, note: 'Imported from Schwab CSV',
        kind: opt.kind,
      });
      bump(openLong, k, -row.quantity);
    } else if (action === 'expired') {
      // Schwab's quantity sign on Expired rows: negative = a LONG contract
      // expired, positive = short. More reliable than replay when the opening
      // trade predates the export window; fall back to replay when positive.
      const isLong =
        row.signedQty < 0 ||
        (row.signedQty >= 0 && (openShort.get(k) ?? 0) <= 0 && (openLong.get(k) ?? 0) > 0);
      if (isLong) {
        p.longTxns.push({
          type: 'SELL', date: row.date, contracts: row.quantity, strike: opt.strike,
          expiration: opt.expiration, price: 0, fees: row.fees, note: 'Expired worthless (imported)',
          kind: opt.kind,
        });
        bump(openLong, k, -row.quantity);
      } else {
        const note = (openShort.get(k) ?? 0) > 0
          ? 'Imported from Schwab CSV'
          : 'Imported; assumed short (opening trade predates this export?)';
        shortLedger.push({ ...base, type: 'EXPIRED', price: null, note });
        bump(openShort, k, -row.quantity);
      }
    } else if (action === 'assigned') {
      const note = (openShort.get(k) ?? 0) > 0
        ? 'Imported from Schwab CSV'
        : 'Imported; assumed short (opening trade predates this export?)';
      shortLedger.push({ ...base, type: 'ASSIGNED', price: null, note });
      bump(openShort, k, -row.quantity);
    } else if (action === 'exchange or exercise') {
      skipped.push({
        line: row.line,
        reason: 'Exercise rows need manual entry (they convert an option into a stock trade)',
        raw: row.raw,
      });
      continue;
    } else if (IGNORED_PATTERNS.test(row.action)) {
      ignoredCount++;
      continue;
    } else {
      skipped.push({ line: row.line, reason: `Unrecognized option action "${row.action}"`, raw: row.raw });
      continue;
    }
    touchDates(p, row.date);
  }

  // Schwab reports an assignment as TWO rows: the "Assigned" option row plus
  // an explicit stock Buy (short put) or Sell (short call) at the strike.
  // The calc engine synthesizes the share movement from the ASSIGNED entry,
  // so drop the paired stock row or the shares would be double-counted.
  for (const p of plans.values()) {
    const pairOff = (assigned: Omit<OptionTxn, 'id'>, stockType: 'BUY' | 'SELL') => {
      const i = p.stockTxns.findIndex(
        (s) =>
          s.type === stockType &&
          s.date === assigned.date &&
          Math.abs(s.shares - assigned.contracts * 100) < 0.01 &&
          Math.abs(s.price - (assigned.strike ?? 0)) < 0.011
      );
      if (i >= 0) {
        const [removed] = p.stockTxns.splice(i, 1);
        assigned.fees = (assigned.fees || 0) + (removed.fees || 0);
        assigned.note += ' · paired stock row folded in';
      }
    };
    for (const t of p.putTxns) if (t.type === 'ASSIGNED') pairOff(t, 'BUY');
    for (const t of p.callTxns) if (t.type === 'ASSIGNED') pairOff(t, 'SELL');
  }

  return {
    plans: finalizePlans(plans),
    skipped,
    ignoredCount,
    totalDataRows: dataRows.length,
  };
}
