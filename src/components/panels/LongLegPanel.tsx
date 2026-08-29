import { useState } from 'react';
import type { FormEvent } from 'react';
import { usePositions } from '../../context/PositionsContext';
import { useConfirm } from '../../context/ConfirmContext';
import { fmtDate, fmtMoney, fmtNum, num, plClass, todayStr } from '../../lib/format';
import type { LongTxn, Position } from '../../types';

function rowCashFlow(t: { type: 'BUY' | 'SELL'; contracts: number; price: number; fees: number }): number {
  return t.type === 'BUY'
    ? -(t.contracts * t.price * 100 + (t.fees || 0))
    : t.contracts * t.price * 100 - (t.fees || 0);
}

interface Draft {
  type: 'BUY' | 'SELL';
  date: string;
  contracts: string;
  strike: string;
  expiration: string;
  price: string;
  fees: string;
  note: string;
}

export default function LongLegPanel({ position, kind = 'C' }: { position: Position; kind?: 'C' | 'P' }) {
  const { addLongTxn, updateTxn, deleteTxn } = usePositions();
  const confirm = useConfirm();
  const [type, setType] = useState<'BUY' | 'SELL'>('BUY');
  const [date, setDate] = useState(todayStr());
  const [contracts, setContracts] = useState('');
  const [strike, setStrike] = useState('');
  const [expiration, setExpiration] = useState('');
  const [price, setPrice] = useState('');
  const [fees, setFees] = useState('0');
  const [note, setNote] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const txns = [...position.longTxns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  function resetForm() {
    setType('BUY');
    setDate(todayStr());
    setContracts('');
    setStrike('');
    setExpiration('');
    setPrice('');
    setFees('0');
    setNote('');
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    addLongTxn(position.id, {
      type,
      date,
      contracts: num(contracts),
      strike: num(strike),
      expiration,
      price: num(price),
      fees: num(fees),
      note: note.trim(),
      kind,
    });
    resetForm();
  }

  function startEdit(t: LongTxn) {
    setEditingId(t.id);
    setDraft({
      type: t.type,
      date: t.date,
      contracts: String(t.contracts),
      strike: String(t.strike),
      expiration: t.expiration,
      price: String(t.price),
      fees: String(t.fees || 0),
      note: t.note,
    });
  }
  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }
  function saveEdit() {
    if (!editingId || !draft) return;
    updateTxn(position.id, 'long', editingId, {
      type: draft.type,
      date: draft.date,
      contracts: num(draft.contracts),
      strike: num(draft.strike),
      expiration: draft.expiration,
      price: num(draft.price),
      fees: num(draft.fees),
      note: draft.note.trim(),
    });
    cancelEdit();
  }

  const legLabel = kind === 'P' ? 'Put' : 'Call';

  return (
    <div className="panel">
      <h3>Long {legLabel} Leg</h3>
      {txns.length === 0 ? (
        <p className="hint">No long {legLabel.toLowerCase()} transactions yet.</p>
      ) : (
        <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Contracts</th>
              <th>Strike</th>
              <th>Expiration</th>
              <th>Premium/sh</th>
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
                      value={draft.contracts}
                      onChange={(e) => setDraft({ ...draft, contracts: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="inline-edit inline-edit-num"
                      value={draft.strike}
                      onChange={(e) => setDraft({ ...draft, strike: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="date"
                      className="inline-edit inline-edit-date"
                      value={draft.expiration}
                      onChange={(e) => setDraft({ ...draft, expiration: e.target.value })}
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
                  <td
                    className={plClass(
                      rowCashFlow({ type: draft.type, contracts: num(draft.contracts), price: num(draft.price), fees: num(draft.fees) })
                    )}
                  >
                    {fmtMoney(
                      rowCashFlow({ type: draft.type, contracts: num(draft.contracts), price: num(draft.price), fees: num(draft.fees) })
                    )}
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
                  <td>{fmtNum(t.contracts)}</td>
                  <td>{fmtMoney(t.strike)}</td>
                  <td>{fmtDate(t.expiration)}</td>
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
                          deleteTxn(position.id, 'long', t.id);
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
            <span>Contracts</span>
            <input type="number" min="1" step="1" required value={contracts} onChange={(e) => setContracts(e.target.value)} />
          </label>
          <label className="field">
            <span>Strike</span>
            <input type="number" min="0" step="0.01" required value={strike} onChange={(e) => setStrike(e.target.value)} />
          </label>
          <label className="field">
            <span>Expiration</span>
            <input type="date" required value={expiration} onChange={(e) => setExpiration(e.target.value)} />
          </label>
        </div>
        <div className="form-row">
          <label className="field">
            <span>Premium/Share</span>
            <input type="number" min="0" step="0.01" required value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label className="field">
            <span>Fees</span>
            <input type="number" min="0" step="0.01" value={fees} onChange={(e) => setFees(e.target.value)} />
          </label>
          <label className="field field-wide">
            <span>Note (optional)</span>
            <input type="text" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <div className="modal-actions">
          <button type="submit" className="btn btn-secondary">
            Add Long {legLabel} Transaction
          </button>
        </div>
      </form>
    </div>
  );
}
