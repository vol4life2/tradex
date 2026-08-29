import { useMemo, useState } from 'react';
import Modal from './Modal';
import { usePositions } from '../context/PositionsContext';
import { useToast } from '../context/ToastContext';
import { computePositionMetrics } from '../lib/calc';
import { fmtDate, fmtMoney, fmtNum } from '../lib/format';
import { positionStrategyLabel } from '../lib/strategyLabel';
import type { Position } from '../types';

type Kind = 'stock' | 'long' | 'call' | 'put';

interface Row {
  id: string;
  kind: Kind;
  date: string;
  type: string;
  qty: number;
  qtyLabel: string;
  strike: number | null;
  price: number | null;
}

const KIND_LABEL: Record<Kind, string> = { stock: 'Stock', long: 'Long Call', call: 'Call', put: 'Put' };

const NEW_CHOICE = 'new';

function buildRows(position: Position): Row[] {
  const rows: Row[] = [
    ...position.stockTxns.map((t): Row => ({
      id: t.id, kind: 'stock', date: t.date, type: t.type, qty: t.shares, qtyLabel: `${fmtNum(t.shares)} sh`,
      strike: null, price: t.price,
    })),
    ...position.longTxns.map((t): Row => ({
      id: t.id, kind: 'long', date: t.date, type: t.type, qty: t.contracts, qtyLabel: `${fmtNum(t.contracts)} ct`,
      strike: t.strike, price: t.price,
    })),
    ...position.optionTxns.map((t): Row => ({
      id: t.id, kind: 'call', date: t.date, type: t.type, qty: t.contracts, qtyLabel: `${fmtNum(t.contracts)} ct`,
      strike: t.strike, price: t.price,
    })),
    ...position.putTxns.map((t): Row => ({
      id: t.id, kind: 'put', date: t.date, type: t.type, qty: t.contracts, qtyLabel: `${fmtNum(t.contracts)} ct`,
      strike: t.strike, price: t.price,
    })),
  ];
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export default function SplitPositionModal({
  position,
  onClose,
  onSplit,
}: {
  position: Position;
  onClose: () => void;
  onSplit: (newPositionId: string) => void;
}) {
  const { positions, splitPosition } = usePositions();
  const { toast } = useToast();
  const rows = useMemo(() => buildRows(position), [position]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [destination, setDestination] = useState<string>(NEW_CHOICE);

  // Other positions this ticker/account's transactions could be merged into
  // instead of spinning up a new one — e.g. moving a stray leg into the
  // trade group it actually belongs to.
  const mergeCandidates = useMemo(
    () =>
      positions.filter(
        (p) => p.id !== position.id && p.ticker.toUpperCase() === position.ticker.toUpperCase() && (p.account ?? null) === (position.account ?? null)
      ),
    [positions, position]
  );
  const describeCandidate = (p: Position) => {
    const m = computePositionMetrics(p);
    return `${p.name ?? positionStrategyLabel(p)} · ${m.fullyClosed ? 'closed' : 'open'}`;
  };

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectThrough(index: number) {
    setSelected(new Set(rows.slice(0, index + 1).map((r) => r.id)));
  }

  function selectAll() {
    setSelected(new Set(rows.map((r) => r.id)));
  }
  function selectNone() {
    setSelected(new Set());
  }

  function handleConfirm() {
    const selection = {
      stockTxnIds: rows.filter((r) => r.kind === 'stock' && selected.has(r.id)).map((r) => r.id),
      longTxnIds: rows.filter((r) => r.kind === 'long' && selected.has(r.id)).map((r) => r.id),
      optionTxnIds: rows.filter((r) => r.kind === 'call' && selected.has(r.id)).map((r) => r.id),
      putTxnIds: rows.filter((r) => r.kind === 'put' && selected.has(r.id)).map((r) => r.id),
    };
    const targetPositionId = destination === NEW_CHOICE ? undefined : destination;
    const destinationId = splitPosition(position.id, selection, targetPositionId);
    if (destinationId) {
      toast(
        targetPositionId
          ? `Moved ${selected.size} transaction(s) into ${mergeCandidates.find((p) => p.id === targetPositionId)?.name ?? 'the existing position'}`
          : `Split ${selected.size} transaction(s) into a new position`
      );
      onSplit(destinationId);
    }
  }

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const destinationLabel = mergeCandidates.find((p) => p.id === destination)?.name;

  return (
    <Modal onClose={onClose} wide>
      <h2>Split {position.ticker} {destination === NEW_CHOICE ? 'into a new position' : 'into another position'}</h2>
      <p className="hint">
        Check the transactions that belong to a separate episode (e.g. an old, fully-closed strangle before this
        ticker became a diagonal) and move them to a new position of their own, or into an existing{' '}
        {position.ticker} position they actually belong to. Either way the affected positions' strategies are
        re-inferred from what ends up in them.
      </p>

      {mergeCandidates.length > 0 && (
        <div className="split-actions-row">
          <label htmlFor="split-destination">Destination:</label>
          <select id="split-destination" value={destination} onChange={(e) => setDestination(e.target.value)}>
            <option value={NEW_CHOICE}>Create new position</option>
            {mergeCandidates.map((p) => (
              <option key={p.id} value={p.id}>
                Move into: {describeCandidate(p)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="split-actions-row">
        <button type="button" className="btn btn-ghost" onClick={allSelected ? selectNone : selectAll}>
          {allSelected ? 'Select None' : 'Select All'}
        </button>
        <span className="hint-inline">{selected.size} of {rows.length} selected</span>
      </div>

      <div className="import-preview">
        <table className="table">
          <thead>
            <tr>
              <th></th>
              <th>Date</th>
              <th>Ledger</th>
              <th>Type</th>
              <th>Qty</th>
              <th>Strike</th>
              <th>Price</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                </td>
                <td>{fmtDate(r.date)}</td>
                <td>{KIND_LABEL[r.kind]}</td>
                <td>{r.type}</td>
                <td>{r.qtyLabel}</td>
                <td>{r.strike != null ? fmtMoney(r.strike) : '—'}</td>
                <td>{r.price != null ? fmtMoney(r.price) : '—'}</td>
                <td>
                  <button type="button" className="btn btn-ghost btn-icon" title="Select this row and everything above it" onClick={() => selectThrough(i)}>
                    ↑ here
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={selected.size === 0} onClick={handleConfirm}>
          Move {selected.size || ''} Transaction{selected.size === 1 ? '' : 's'}{' '}
          {destination === NEW_CHOICE ? 'to New Position' : `into ${destinationLabel ?? 'Position'}`}
        </button>
      </div>
    </Modal>
  );
}
