/*
 * tastytradeCsv.ts — parser for tastytrade's gain/loss tax worksheet CSV
 * (the "YYYY-<acct>-gain_loss_tax_worksheet.csv" download).
 *
 * This is a CLOSED-LOTS file, not a fills history — but unlike a bare 1099-B
 * each row carries BOTH ends of the round trip (open date + cost, close date
 * + proceeds, long/short flag, close event), so we can reconstruct the pair
 * of ledger transactions faithfully:
 *
 *   LONG_SHORT_IND = S  →  STO at open (NO_WS_PROCEEDS), then
 *                          Buy → BTC (NO_WS_COST) | OptionExpiration → EXPIRED
 *   LONG_SHORT_IND = L  →  BTO/BUY at open (NO_WS_COST), then
 *                          Sell → STC/SELL (NO_WS_PROCEEDS) | OptionExpiration → close at $0
 *
 * Rows with an empty CLOSE_EVENT (sublot ids starting "OS") are OPEN lots —
 * mark-to-market section-1256 positions. We synthesize just their opening
 * transaction; for open shorts the credit sits in NO_WS_COST as a negative.
 *
 * Fees are already netted into cost/proceeds, so per-share prices divide
 * them out directly and synthesized fees are 0 — cash flows reproduce the
 * worksheet's numbers exactly.
 *
 * Caveat: positions closed entirely outside the file's tax year, and open
 * non-1256 lots, do not appear. tastytrade's History → Transactions export
 * would carry those; that's a separate (addable) format.
 */

import { parseCsv, parseMoney, emptyPlan, finalizePlans } from './schwabCsv';
import type { ParsedImport, SkippedRow, TickerPlan } from './schwabCsv';

// OCC-style compact option symbol: INTC260116P00037000
const OCC = /^([A-Z][A-Z0-9./]*?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

function parseOcc(symbol: string) {
  const m = OCC.exec(symbol.trim());
  if (!m) return null;
  return {
    ticker: m[1].toUpperCase(),
    expiration: `20${m[2]}-${m[3]}-${m[4]}`,
    kind: m[5] as 'C' | 'P',
    strike: parseInt(m[6], 10) / 1000,
  };
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function parseTastytradeCsv(text: string): ParsedImport {
  const rows = parseCsv(text);
  const skipped: SkippedRow[] = [];

  const headerIdx = rows.findIndex(
    (r) => r.includes('TAX_YEAR') && r.includes('SUBLOT_ID') && r.includes('CLOSE_EVENT')
  );
  if (headerIdx === -1) {
    throw new Error(
      'Could not find a tastytrade gain/loss header (TAX_YEAR, SUBLOT_ID, CLOSE_EVENT...). Is this the gain/loss tax worksheet CSV?'
    );
  }
  const header = rows[headerIdx].map((c) => c.trim());
  const col = (name: string) => header.indexOf(name);
  const iSymbol = col('SYMBOL');
  const iSecType = col('SEC_TYPE');
  const iOpenDate = col('OPEN_DATE');
  const iCloseDate = col('CLOSE_DATE');
  const iCloseEvent = col('CLOSE_EVENT');
  const iQty = col('QUANTITY');
  const iLS = col('LONG_SHORT_IND');
  const iCost = col('NO_WS_COST');
  const iProceeds = col('NO_WS_PROCEEDS');

  const plans = new Map<string, TickerPlan>();
  const getPlan = (ticker: string): TickerPlan => {
    let p = plans.get(ticker);
    if (!p) {
      p = emptyPlan(ticker, 'tastytrade');
      plans.set(ticker, p);
    }
    return p;
  };
  const touchDates = (p: TickerPlan, ...dates: (string | null)[]) => {
    for (const d of dates) {
      if (!d) continue;
      if (!p.firstDate || d < p.firstDate) p.firstDate = d;
      if (!p.lastDate || d > p.lastDate) p.lastDate = d;
    }
  };

  let totalDataRows = 0;
  const NOTE = 'Imported from tastytrade gain/loss CSV';

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.every((c) => c.trim() === '')) continue;
    const rawLine = cells.join(',');
    totalDataRows++;

    const symbol = (cells[iSymbol] ?? '').trim();
    const secType = (cells[iSecType] ?? '').trim();
    const openDate = (cells[iOpenDate] ?? '').trim();
    const closeDate = (cells[iCloseDate] ?? '').trim();
    const closeEvent = (cells[iCloseEvent] ?? '').trim();
    const qty = Math.abs(parseMoney(cells[iQty]));
    const ls = (cells[iLS] ?? '').trim().toUpperCase();
    const cost = parseMoney(cells[iCost]);
    const proceeds = parseMoney(cells[iProceeds]);

    if (!isIsoDate(openDate) || qty <= 0) {
      skipped.push({ line: r + 1, reason: 'No parseable open date or quantity', raw: rawLine });
      continue;
    }
    const isOpenLot = closeEvent === '';
    if (!isOpenLot && !isIsoDate(closeDate)) {
      skipped.push({ line: r + 1, reason: `Close event "${closeEvent}" without a close date`, raw: rawLine });
      continue;
    }

    // ----- stock lots -----
    if (secType === 'Equity') {
      if (ls !== 'L') {
        skipped.push({ line: r + 1, reason: 'Short stock lots are not supported', raw: rawLine });
        continue;
      }
      const p = getPlan(symbol.toUpperCase());
      p.stockTxns.push({ type: 'BUY', date: openDate, shares: qty, price: cost / qty, fees: 0, note: NOTE });
      if (!isOpenLot) {
        p.stockTxns.push({ type: 'SELL', date: closeDate, shares: qty, price: proceeds / qty, fees: 0, note: NOTE });
      }
      touchDates(p, openDate, isOpenLot ? null : closeDate);
      continue;
    }

    // ----- option lots -----
    const opt = parseOcc(symbol);
    if (!opt) {
      skipped.push({ line: r + 1, reason: `Unrecognized symbol format "${symbol}"`, raw: rawLine });
      continue;
    }
    const p = getPlan(opt.ticker);
    const base = {
      date: openDate,
      contracts: qty,
      strike: opt.strike,
      expiration: opt.expiration,
      fees: 0,
      note: NOTE,
    };
    const closeBase = { ...base, date: closeDate };

    if (ls === 'S') {
      // Open credit: proceeds column when closed; for open lots it sits in
      // NO_WS_COST as a negative number.
      const openCredit = isOpenLot ? -cost : proceeds;
      const ledger = opt.kind === 'C' ? p.callTxns : p.putTxns;
      ledger.push({ ...base, type: 'STO', price: openCredit / qty / 100 });
      if (!isOpenLot) {
        if (closeEvent === 'OptionExpiration') {
          ledger.push({ ...closeBase, type: 'EXPIRED', price: null });
        } else if (closeEvent === 'Buy') {
          ledger.push({ ...closeBase, type: 'BTC', price: cost / qty / 100 });
        } else {
          skipped.push({ line: r + 1, reason: `Unrecognized close event "${closeEvent}" on short lot`, raw: rawLine });
          ledger.pop(); // roll back the STO we just pushed
          continue;
        }
      }
    } else if (ls === 'L') {
      // Long leg — defaults into the diagonal/calendar ledger regardless of
      // call or put; finalizePlans' promoteSameExpirationSpreads moves it
      // into the matching short ledger afterward if its expiration turns out
      // to match a short leg of the same kind (same-week vertical, not a
      // calendar/diagonal).
      p.longTxns.push({
        type: 'BUY', date: openDate, contracts: qty, strike: opt.strike,
        expiration: opt.expiration, price: cost / qty / 100, fees: 0, note: NOTE,
        kind: opt.kind,
      });
      if (!isOpenLot) {
        if (closeEvent === 'Sell' || closeEvent === 'OptionExpiration') {
          p.longTxns.push({
            type: 'SELL', date: closeDate, contracts: qty, strike: opt.strike,
            expiration: opt.expiration,
            price: closeEvent === 'OptionExpiration' ? 0 : proceeds / qty / 100,
            fees: 0,
            note: closeEvent === 'OptionExpiration' ? 'Expired worthless (imported)' : NOTE,
            kind: opt.kind,
          });
        } else {
          skipped.push({
            line: r + 1,
            reason: `Unrecognized close event "${closeEvent}" on long ${opt.kind === 'C' ? 'call' : 'put'} lot`,
            raw: rawLine,
          });
          p.longTxns.pop();
          continue;
        }
      }
    } else {
      skipped.push({ line: r + 1, reason: `Unrecognized LONG_SHORT_IND "${ls}"`, raw: rawLine });
      continue;
    }
    touchDates(p, openDate, isOpenLot ? null : closeDate);
  }

  return {
    plans: finalizePlans(plans),
    skipped,
    ignoredCount: 0,
    totalDataRows,
  };
}

/** Sniff which broker format a CSV is, from its raw text. */
export function detectCsvFormat(text: string): 'tastytrade' | 'schwab' | 'unknown' {
  const head = text.slice(0, 2000);
  if (head.includes('TAX_YEAR') && head.includes('SUBLOT_ID')) return 'tastytrade';
  if (/"?Date"?\s*,\s*"?Action"?\s*,\s*"?Symbol"?/i.test(head)) return 'schwab';
  return 'unknown';
}
