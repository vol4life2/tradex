import { useEffect, useMemo, useState } from 'react';
import { usePositions } from '../context/PositionsContext';
import { useConfirm } from '../context/ConfirmContext';
import { useToast } from '../context/ToastContext';
import { computePositionMetrics } from '../lib/calc';
import { fmtMoney, fmtNum, plClass } from '../lib/format';
import { positionStrategyLabel } from '../lib/strategyLabel';
import type { Position } from '../types';

const ALL_ACCOUNTS = 'all';
const NO_ACCOUNT = '(no account)';

export default function Dashboard({ onOpenPosition }: { onOpenPosition: (id: string) => void }) {
  const { positions, deletePosition, deletePositions } = usePositions();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [accountFilter, setAccountFilter] = useState<string>(ALL_ACCOUNTS);

  // Distinct accounts seen across all positions, for the filter dropdown.
  const accounts = useMemo(() => {
    const set = new Set<string>();
    for (const p of positions) set.add(p.account ?? NO_ACCOUNT);
    return [...set].sort();
  }, [positions]);

  // Positions the filter narrows down to — everything below (totals, table,
  // select-all) works off this instead of the raw `positions` list.
  const visiblePositions = useMemo(() => {
    if (accountFilter === ALL_ACCOUNTS) return positions;
    return positions.filter((p) => (p.account ?? NO_ACCOUNT) === accountFilter);
  }, [positions, accountFilter]);

  // Reset to "All Accounts" if the selected account no longer exists (e.g.
  // its last position got deleted) rather than silently showing zero rows.
  useEffect(() => {
    if (accountFilter !== ALL_ACCOUNTS && !accounts.includes(accountFilter)) {
      setAccountFilter(ALL_ACCOUNTS);
    }
  }, [accountFilter, accounts]);

  const summary = useMemo(() => {
    let netPremium = 0,
      realized = 0,
      unrealized = 0,
      openCount = 0,
      closedCount = 0;
    for (const p of visiblePositions) {
      const m = computePositionMetrics(p);
      netPremium += m.netPremiumCollected || 0;
      if (m.fullyClosed) {
        realized += m.realizedPL || 0;
        closedCount++;
      } else {
        openCount++;
        if (m.unrealizedPL != null) unrealized += m.unrealizedPL;
      }
    }
    return { netPremium, realized, unrealized, openCount, closedCount };
  }, [visiblePositions]);

  // Selection can go stale if a position gets deleted elsewhere (e.g. from
  // the detail view) — drop any ids that no longer exist rather than trust it.
  const validSelected = useMemo(() => {
    const ids = new Set(positions.map((p) => p.id));
    return new Set([...selected].filter((id) => ids.has(id)));
  }, [selected, positions]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const visibleIds = visiblePositions.map((p) => p.id);
    const visibleSelectedCount = visibleIds.filter((id) => validSelected.has(id)).length;
    if (visibleSelectedCount === visibleIds.length) {
      // Everything currently visible is selected — clear just those, leaving
      // any selection on filtered-out rows alone.
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      });
    } else {
      setSelected((prev) => new Set([...prev, ...visibleIds]));
    }
  }

  async function handleBulkDelete() {
    const ids = [...validSelected];
    if (ids.length === 0) return;
    const tickers = positions.filter((p) => validSelected.has(p.id)).map((p) => p.ticker);
    const preview = tickers.slice(0, 6).join(', ') + (tickers.length > 6 ? `, +${tickers.length - 6} more` : '');
    if (
      await confirm(`All transactions in these ${ids.length} position(s) will be permanently deleted:\n${preview}`, {
        title: `Delete ${ids.length} position(s)?`,
      })
    ) {
      deletePositions(ids);
      setSelected(new Set());
      toast(`Deleted ${ids.length} position(s)`);
    }
  }

  const visibleIds = visiblePositions.map((p) => p.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => validSelected.has(id));

  return (
    <>
      {accounts.length > 1 && (
        <div className="account-filter-row">
          <label className="field">
            <span>Account</span>
            <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
              <option value={ALL_ACCOUNTS}>All Accounts</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-label">Open Positions</div>
          <div className="summary-value">{summary.openCount}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Net Premium Collected (all-time)</div>
          <div className={`summary-value ${plClass(summary.netPremium)}`}>{fmtMoney(summary.netPremium)}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Unrealized P&amp;L (priced positions)</div>
          <div className={`summary-value ${plClass(summary.unrealized)}`}>{fmtMoney(summary.unrealized)}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Realized P&amp;L ({summary.closedCount} closed)</div>
          <div className={`summary-value ${plClass(summary.realized)}`}>{fmtMoney(summary.realized)}</div>
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="empty-state">
          <p>No positions yet.</p>
        </div>
      ) : visiblePositions.length === 0 ? (
        <div className="empty-state">
          <p>No positions for this account.</p>
        </div>
      ) : (
        <>
          {validSelected.size > 0 && (
            <div className="bulk-action-bar">
              <span>{validSelected.size} selected</span>
              <button className="btn btn-ghost" onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <button className="btn btn-danger" onClick={handleBulkDelete}>
                🗑 Delete Selected
              </button>
            </div>
          )}
          <div className="table-scroll">
          <table className="table positions-table">
            <thead>
              <tr>
                <th className="select-col">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all" />
                </th>
                <th>Ticker</th>
                <th>Strategy</th>
                <th>Status</th>
                <th>Qty Held</th>
                <th>Net Premium</th>
                <th>Breakeven / Eff. Basis</th>
                <th>Unrealized / Realized P&amp;L</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visiblePositions.map((p) => (
                <PositionRow
                  key={p.id}
                  position={p}
                  selected={validSelected.has(p.id)}
                  onToggleSelect={() => toggle(p.id)}
                  onOpen={() => onOpenPosition(p.id)}
                  onDelete={deletePosition}
                />
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </>
  );
}

function PositionRow({
  position: p,
  selected,
  onToggleSelect,
  onOpen,
  onDelete,
}: {
  position: Position;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onDelete: (id: string) => void;
}) {
  const confirm = useConfirm();
  const m = computePositionMetrics(p);
  // Narrow on m.strategy (the discriminant), not p.strategy, so TS narrows the union.
  let qty: string;
  let basis: number | null;
  switch (m.strategy) {
    case 'diagonal':
    case 'put_diagonal':
      qty = `${fmtNum(m.openLongContracts)} ct`;
      basis = m.effectiveCostBasisPerContract;
      break;
    case 'covered_call':
    case 'stock':
      qty = m.sharesHeld === 0 ? `${fmtNum(m.openShortPuts)} put(s)` : `${fmtNum(m.sharesHeld)} sh`;
      basis = m.breakevenPrice;
      break;
    case 'credit_vertical':
    case 'debit_vertical':
      qty = `${fmtNum(m.openShortContracts)}S / ${fmtNum(m.openLongContracts)}L`;
      basis = null;
      break;
    case 'strangle':
      qty = `${fmtNum(m.openShortPuts)}P / ${fmtNum(m.openShortCalls)}C`;
      basis = null;
      break;
  }
  const pl = m.fullyClosed ? m.realizedPL : m.unrealizedPL;
  const plLabel = m.fullyClosed ? 'Realized' : pl == null ? 'Unrealized (no price set)' : 'Unrealized';

  return (
    <tr className={`row-clickable${selected ? ' row-selected' : ''}`} onClick={onOpen}>
      <td className="select-col" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={onToggleSelect} />
      </td>
      <td className="ticker-cell">
        {p.ticker}
        {p.account && <span className="account-tag">{p.account}</span>}
        {p.name && <div className="position-name-subtitle">{p.name}</div>}
      </td>
      <td>{positionStrategyLabel(p)}</td>
      <td>
        {m.fullyClosed ? <span className="chip chip-closed">CLOSED</span> : <span className="chip chip-open">OPEN</span>}
        {m.needsAttention && (
          <span className="chip chip-warn" title="A leg was assigned, or there's stray data outside this strategy's normal ledgers — open the position for details">
            {' '}
            needs attention
          </span>
        )}
      </td>
      <td>{qty}</td>
      <td className={plClass(m.netPremiumCollected)}>{fmtMoney(m.netPremiumCollected)}</td>
      <td>{basis == null ? '—' : fmtMoney(basis)}</td>
      <td className={plClass(pl)} title={plLabel}>
        {pl == null ? '—' : fmtMoney(pl)}
      </td>
      <td className="row-actions">
        <button
          className="btn btn-icon"
          title="Delete position"
          onClick={async (e) => {
            e.stopPropagation();
            if (await confirm(`All of ${p.ticker}'s transactions will be permanently deleted.`, { title: `Delete ${p.ticker}?` })) {
              onDelete(p.id);
            }
          }}
        >
          🗑
        </button>
      </td>
    </tr>
  );
}
