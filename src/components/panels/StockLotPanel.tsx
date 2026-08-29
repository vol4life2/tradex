import { useState } from 'react';
import type { FormEvent } from 'react';
import { usePositions } from '../../context/PositionsContext';
import { useConfirm } from '../../context/ConfirmContext';
import { fmtDate, fmtMoney, fmtNum, num, plClass, todayStr } from '../../lib/format';
import type { Position, StockTxn } from '../../types';

function rowCashFlow(t: { type: 'BUY' | 'SELL'; shares: number; price: number; fees: number }): number {
  return t.type === 'BUY' ? -(t.shares * t.price + (t.fees || 0)) : t.shares * t.price - (t.fees || 0);
}

interface Draft {
  type: 'BUY' | 'SELL';
  date: string;
  shares: string;
  price: string;
  fees: string;
  note: string;
}

export default function StockLotPanel({ position }: { position: Position }) {
  const { addStockTxn, updateTxn, deleteTxn } = usePositions();
  const confirm = useConfirm();
  const [type, setType] = useState<'BUY' | 'SELL'>('BUY');
  const [date, setDate] = useState(todayStr());
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [fees, setFees] = useState('0');
  const [note, setNote] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const txns = [...position.stockTxns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  function resetForm() {
    setType('BUY');
    setDate(todayStr());
    setShares('');
    setPrice('');
    setFees('0');
    setNote('');
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    addStockTxn(position.id, {
      type,
      date,
      shares: num(shares),
      price: num(price),
      fees: num(fees),
      note: note.trim(),
    });
    resetForm();
  }

  function startEdit(t: StockTxn) {
    setEditingId(t.id);
    setDraft({ type: t.type, date: t.date, shares: String(t.shares), price: String(t.price), fees: String(t.fees || 0), note: t.note });
  }
  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }
  function saveEdit() {
    if (!editingId || !draft) return;
    updateTxn(position.id, 'stock', editingId, {
      type: draft.type,
      date: draft.date,
      shares: num(draft.shares),
      price: num(draft.price),
      fees: num(draft.fees),
      note: draft.note.trim(),
    });
    cancelEdit();
  }

  return (
    <div className="panel">
      <h3>Stock Lots</h3>
      {txns.length === 0 ? (
        <p className="hint">No stock lots yet.</p>
      ) : (
        <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Shares</th>
              <th>Price</th>
              <th>Fees</th>
              <th>Cash Flow</th>
              <th>Note</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) =>
              t.id === editingId && draft ? (
                <tr key={t.id} className="row-editing">
                  <td>
                    <input
                      type="date"
                      className="inline-edit inline-edit-date"
                      value={draft.date}
                      onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="inline-edit"
                      value={draft.type}
                      onChange={(e) => setDraft({ ...draft, type: e.target.value as 'BUY' | 'SELL' })}
                    >
                      <option value="BUY">Buy</option>
                      <option value="SELL">Sell</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      className="inline-edit inline-edit-num"
                      value={draft.shares}
                      onChange={(e) => setDraft({ ...draft, shares: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="inline-edit inline-edit-num"
                      value={draft.price}
                      onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="inline-edit inline-edit-num"
                      value={draft.fees}
                      onChange={(e) => setDraft({ ...draft, fees: e.target.value })}
                    />
                  </td>
                  <td className={plClass(rowCashFlow({ type: draft.type, shares: num(draft.shares), price: num(draft.price), fees: num(draft.fees) }))}>
                    {fmtMoney(rowCashFlow({ type: draft.type, shares: num(draft.shares), price: num(draft.price), fees: num(draft.fees) }))}
                  </td>
                  <td>
                    <input
                      type="text"
                      maxLength={140}
                      className="inline-edit"
                      value={draft.note}
                      onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                    />
                  </td>
                  <td>
                    <button className="btn btn-icon" title="Save" onClick={saveEdit}>
                      ✓
                    </button>
                    <button className="btn btn-icon" title="Cancel" onClick={cancelEdit}>
                      ✕
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={t.id}>
                  <td>{fmtDate(t.date)}</td>
                  <td>
                    <span className={`chip ${t.type === 'BUY' ? 'chip-buy' : 'chip-sell'}`}>{t.type}</span>
                  </td>
                  <td>{fmtNum(t.shares)}</td>
                  <td>{fmtMoney(t.price)}</td>
                  <td>{fmtMoney(t.fees || 0)}</td>
                  <td className={plClass(rowCashFlow(t))}>{fmtMoney(rowCashFlow(t))}</td>
                  <td className="note-cell" title={t.note}>{t.note}</td>
                  <td>
                    <button className="btn btn-icon" title="Edit" onClick={() => startEdit(t)}>
                      ✎
                    </button>
                    <button
                      className="btn btn-icon"
                      title="Delete"
                      onClick={async () => {
                        if (await confirm('This cannot be undone.', { title: 'Delete this transaction?' })) {
                          deleteTxn(position.id, 'stock', t.id);
                        }
                      }}
                    >
                      🗑
                    </button>
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
        </div>
      )}

      <form className="txn-form" onSubmit={handleSubmit}>
        <div className="form-row">
          <label className="field">
            <span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as 'BUY' | 'SELL')}>
              <option value="BUY">Buy</option>
              <option value="SELL">Sell</option>
            </select>
          </label>
          <label className="field">
            <span>Date</span>
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Shares</span>
            <input type="number" min="1" step="1" required value={shares} onChange={(e) => setShares(e.target.value)} />
          </label>
          <label className="field">
            <span>Price/Share</span>
            <input type="number" min="0" step="0.01" required value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label className="field">
            <span>Fees</span>
            <input type="number" min="0" step="0.01" value={fees} onChange={(e) => setFees(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Note (optional)</span>
          <input type="text" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="submit" className="btn btn-secondary">
            Add Stock Transaction
          </button>
        </div>
      </form>
    </div>
  );
}
