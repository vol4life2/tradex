/*
 * tastytradePositionsCsv.ts — parser for tastytrade's live "Positions" tab
 * export (CURRENT open positions with mark/Greeks), not the gain/loss tax
 * worksheet tastytradeCsv.ts handles.
 *
 * Flat CSV, one row per instrument — much simpler than Schwab's hierarchical
 * Position Statement. Columns of interest:
 *   Account, Symbol, Type (OPTION/STOCK/CRYPTO), Quantity (signed),
 *   Exp Date ("Oct 16, 2026"), Strike Price, Call/Put, Mark (signed —
 *   flips with position direction), Trade Price (signed the same way).
 *
 * Signs: Mark/Trade Price are POSITIVE for a short position (credit) and
 * NEGATIVE for a long position (debit) — direction is already carried by
 * Quantity's own sign, so both get abs()'d and only Quantity's sign is used
 * to classify long vs. short.
 */
import { parseCsv, parseMoney } from './schwabCsv';
import type { SnapshotImport, SnapshotLeg, SnapshotTicker } from './positionSnapshot';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "Oct 16, 2026" -> "2026-10-16" */
function parseLongDate(s: string | undefined): string | null {
  const m = s?.match(/([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`;
}

// OCC-style padded symbol: root, then a 6-digit date, C/P, 8-digit strike.
const OPTION_SYMBOL_RE = /^([A-Z]+)\s*\d{6}[CP]\d{8}$/;

export function detectTastytradePositions(text: string): boolean {
  const head = text.slice(0, 500);
  return head.includes('Symbol') && head.includes('Quantity') && head.includes('Mark') && head.includes('Trade Price');
}

export function parseTastytradePositions(text: string): SnapshotImport {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex((r) => r.includes('Symbol') && r.includes('Quantity') && r.includes('Mark'));
  if (headerIdx === -1) {
    throw new Error('Could not find the positions-tab header row (Symbol, Quantity, Mark, ...). Is this a tastytrade Positions export?');
  }
  const header = rows[headerIdx].map((c) => c.trim());
  const col = (name: string) => header.indexOf(name);
  const iSymbol = col('Symbol');
  const iType = col('Type');
  const iQty = col('Quantity');
  const iExpDate = col('Exp Date');
  const iStrike = col('Strike Price');
  const iCallPut = col('Call/Put');
  const iMark = col('Mark');
  const iTradePrice = col('Trade Price');

  const tickers = new Map<string, SnapshotTicker>();
  const account = 'tastytrade';

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.every((c) => c.trim() === '')) continue;
    const type = (cells[iType] ?? '').trim().toUpperCase();
    if (type !== 'OPTION' && type !== 'STOCK') continue; // skip CRYPTO — not a supported strategy

    const symbol = (cells[iSymbol] ?? '').trim();
    const qty = Math.round(parseMoney(cells[iQty]));
    if (qty === 0) continue;
    const mark = Math.abs(parseMoney(cells[iMark]));
    const tradePrice = Math.abs(parseMoney(cells[iTradePrice]));

    let ticker: string;
    let leg: SnapshotLeg;
    if (type === 'STOCK') {
      ticker = symbol;
      leg = { kind: 'stock', qty, strike: null, expiration: null, mark, tradePrice };
    } else {
      const m = symbol.match(OPTION_SYMBOL_RE);
      if (!m) continue; // unrecognized symbol shape — skip rather than guess
      ticker = m[1];
      const strike = parseMoney(cells[iStrike]);
      const expiration = parseLongDate(cells[iExpDate]);
      const cp = (cells[iCallPut] ?? '').trim().toLowerCase();
      if (expiration == null || !Number.isFinite(strike)) continue;
      leg = { kind: cp === 'put' ? 'put' : 'call', qty, strike, expiration, mark, tradePrice };
    }

    if (!tickers.has(ticker)) tickers.set(ticker, { ticker, account, legs: [] });
    tickers.get(ticker)!.legs.push(leg);
  }

  return { asOfDate: null, tickers: [...tickers.values()] };
}
