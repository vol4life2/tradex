import { computeCostBasisHistory } from '../../lib/calc';
import { fmtDate, fmtMoney, plClass } from '../../lib/format';
import type { Position } from '../../types';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** How the effective basis has moved over the position's life, one row per
 *  transaction — the point of the whole app: showing cost basis erode as
 *  premium gets collected, roll by roll. Only rendered for strategies with a
 *  basis concept (covered_call/stock, diagonal/put_diagonal); see
 *  computeCostBasisHistory for the underlying walk. */
export default function CostBasisHistoryPanel({ position }: { position: Position }) {
  const rows = computeCostBasisHistory(position);
  if (rows.length === 0) return null;

  const isDiagonal = position.strategy === 'diagonal' || position.strategy === 'put_diagonal';
  const unitLabel = isDiagonal ? 'Basis/sh (equiv)' : 'Basis/sh';

  // "Starting" basis is the first row where shares/contracts are actually
  // held — not necessarily rows[0], since a stray leg (e.g. a put sold
  // before any stock was ever bought) can chronologically come first with
  // nothing held yet.
  const firstBasis = rows.find((r) => r.basis != null)?.basis ?? null;
  const lastKnownBasis = [...rows].reverse().find((r) => r.basis != null)?.basis ?? null;
  const delta = firstBasis != null && lastKnownBasis != null ? round2(lastKnownBasis - firstBasis) : null;

  return (
    <div className="panel">
      <h3>Cost Basis History</h3>
      {firstBasis != null && (
        <div className="basis-history-summary">
          <span className="basis-history-range">
            {fmtMoney(firstBasis)} <span className="hint-inline">start</span>
            {lastKnownBasis != null && lastKnownBasis !== firstBasis && (
              <>
                {' '}&rarr; {fmtMoney(lastKnownBasis)} <span className="hint-inline">now</span>
              </>
            )}
          </span>
          {delta != null && delta !== 0 && (
            <span className={`chip ${delta < 0 ? 'chip-sell' : 'chip-buy'}`}>
              {delta < 0 ? '↓' : '↑'} {fmtMoney(Math.abs(delta))} from premium
            </span>
          )}
        </div>
      )}
      <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Event</th>
            <th>Cash Flow</th>
            <th>Cum. Premium</th>
            <th>{unitLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{fmtDate(r.date)}</td>
              <td>{r.event}</td>
              <td className={plClass(r.cashFlow)}>{fmtMoney(r.cashFlow)}</td>
              <td className="note-cell">{fmtMoney(r.cumulativePremium)}</td>
              <td className="basis-history-basis">{r.basis == null ? '—' : fmtMoney(r.basis)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
