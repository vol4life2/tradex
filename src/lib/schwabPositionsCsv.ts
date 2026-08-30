/*
 * schwabPositionsCsv.ts — parser for a Schwab/thinkorswim "Position
 * Statement" export (the CURRENT positions/Greeks snapshot, not the
 * transaction-history export schwabCsv.ts handles).
 *
 * This format is a human-readable, hierarchically-grouped CSV — not really
 * designed for machine parsing. Structure, from a real export:
 *
 *   Position Statement for 56146088SCHW (Margin) on 8/29/26 22:00:16
 *   ...
 *   Instrument,Qty,Days,Mark,Last,...,Trade Price,...
 *   CSCO,,,,109.93,...                          <- ticker row (qty blank OR a
 *                                                   real qty for a single
 *                                                   simple position, see FLYYQ)
 *   CUSTOM,,,0,109.93,...                       <- strategy-group label (skip)
 *   CISCO SYS INC,0,,109.93,...                 <- the stock leg (real qty)
 *   DIAGONAL,,,4.365,4.36,...                   <- another group label (skip)
 *   100 16 OCT 26 110 CALL,+1,48,4.70,...        <- an option leg (real qty)
 *   ...
 *   Subtotals:,...                              <- end of the position list
 *
 * Ticker rows are told apart from company-name rows by shape, not position:
 * a ticker is a short bare symbol (e.g. "CSCO", "FLYYQ"); a company name
 * always has a space, lowercase letters, or punctuation ("CISCO SYS INC").
 * A handful of short all-caps words are reserved strategy-group labels
 * (STOCK, SINGLE, CUSTOM, ...) that would otherwise look like tickers.
 *
 * The ticker row's own qty/mark/price are NEVER used as leg data — for a
 * simple single-position ticker (no separate combo), the SAME numbers are
 * always repeated on the company-name row right after it, so using only
 * that row avoids double-counting.
 */
import { parseCsv, parseMoney } from './schwabCsv';
import type { SnapshotImport, SnapshotLeg, SnapshotTicker } from './positionSnapshot';

const GROUP_LABELS = new Set([
  'CUSTOM',
  'DIAGONAL',
  'SINGLE',
  'STOCK',
  'COVERED',
  'VERTICAL',
  'CALENDAR',
  'STRANGLE',
  'STRADDLE',
  'BUTTERFLY',
  'CONDOR',
  'COLLAR',
  'RATIO',
]);

const TICKER_RE = /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/;
// "100 16 OCT 26 110 CALL" — multiplier, day, month, 2-digit year, strike, C/P.
const OPTION_RE = /^\d+\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{2})\s+([\d.]+)\s+(CALL|PUT)$/i;
const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

function optionExpirationToIso(day: string, mon: string, yr2: string): string | null {
  const mm = MONTHS[mon.toUpperCase()];
  if (!mm) return null;
  return `20${yr2}-${mm}-${day.padStart(2, '0')}`;
}

export function detectSchwabPositionStatement(text: string): boolean {
  return /^Position Statement for/i.test(text.trim()) || /Instrument,Qty,Days,Mark/i.test(text.slice(0, 500));
}

export function parseSchwabPositionStatement(text: string, account: string | null = 'Schwab'): SnapshotImport {
  const rows = parseCsv(text);

  // First line: "Position Statement for 56146088SCHW (Margin) on 8/29/26 22:00:16"
  let asOfDate: string | null = null;
  const titleMatch = text.match(/on\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (titleMatch) {
    const [, m, d, yRaw] = titleMatch;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    asOfDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const headerIdx = rows.findIndex((r) => r[0]?.trim() === 'Instrument' && r.some((c) => c.trim() === 'Qty'));
  if (headerIdx === -1) {
    throw new Error('Could not find the "Instrument,Qty,..." header row. Is this a Position Statement export?');
  }
  const header = rows[headerIdx].map((c) => c.trim());
  const col = (name: string) => header.indexOf(name);
  const iQty = col('Qty');
  const iMark = col('Mark');
  const iTradePrice = col('Trade Price');

  const tickers = new Map<string, SnapshotTicker>();
  let currentTicker: string | null = null;

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    const instrument = (cells[0] ?? '').trim();
    if (!instrument) continue;
    if (/^subtotals:?$/i.test(instrument)) break; // end of the position list

    const qtyRaw = (cells[iQty] ?? '').trim();

    if (TICKER_RE.test(instrument) && !GROUP_LABELS.has(instrument)) {
      currentTicker = instrument;
      if (!tickers.has(currentTicker)) tickers.set(currentTicker, { ticker: currentTicker, account, legs: [] });
      continue; // context only — never leg data (see file-header comment)
    }
    if (GROUP_LABELS.has(instrument)) continue;
    if (!currentTicker) continue; // stray row before any ticker seen — ignore

    const optionMatch = instrument.match(OPTION_RE);
    if (optionMatch) {
      if (qtyRaw === '') continue; // malformed — no position size
      const [, day, mon, yr2, strikeStr, cp] = optionMatch;
      const expiration = optionExpirationToIso(day, mon, yr2);
      const strike = parseFloat(strikeStr);
      if (expiration == null || !Number.isFinite(strike)) continue;
      const leg: SnapshotLeg = {
        kind: cp.toUpperCase() === 'PUT' ? 'put' : 'call',
        qty: Math.round(parseMoney(qtyRaw)),
        strike,
        expiration,
        mark: Math.abs(parseMoney(cells[iMark])),
        tradePrice: Math.abs(parseMoney(cells[iTradePrice])),
      };
      tickers.get(currentTicker)!.legs.push(leg);
      continue;
    }

    // Not a ticker, not a group label, not an option row — a stock-name leg
    // row (e.g. "CISCO SYS INC", "SPIRIT AVIATION HLDG").
    if (qtyRaw === '') continue;
    const leg: SnapshotLeg = {
      kind: 'stock',
      qty: Math.round(parseMoney(qtyRaw)),
      strike: null,
      expiration: null,
      mark: Math.abs(parseMoney(cells[iMark])),
      tradePrice: Math.abs(parseMoney(cells[iTradePrice])),
    };
    tickers.get(currentTicker)!.legs.push(leg);
  }

  return { asOfDate, tickers: [...tickers.values()] };
}
