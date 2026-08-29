import { useState } from 'react';
import type { FormEvent } from 'react';
import { usePositions } from '../../context/PositionsContext';
import type { OptionLeg } from '../../context/PositionsContext';
import { useConfirm } from '../../context/ConfirmContext';
import { fmtDate, fmtMoney, fmtNum, num, plClass, todayStr } from '../../lib/format';
import type { OptionTxn, OptionTxnType, Position } from '../../types';

const OPTION_TYPE_LABEL: Record<OptionTxnType, string> = {
  STO: 'Sell to Open',
  BTC: 'Buy to Close',
  BTO: 'Buy to Open (long)',
  STC: 'Sell to Close (long)',
  EXPIRED: 'Expired Worthless',
  ASSIGNED: 'Assigned',
};
const OPTION_TYPE_CLASS: Record<OptionTxnType, string> = {
  STO: 'chip-sell',
  BTC: 'chip-buy',
  BTO: 'chip-buy',
  STC: 'chip-sell',
  EXPIRED: 'chip-muted',
  ASSIGNED: 'chip-warn',
};

const PRICED_TYPES: OptionTxnType[] = ['STO', 'BTC', 'BTO', 'STC'];

function rowCashFlow(t: { type: OptionTxnType; contracts: number; strike: number | null; price: number | null; fees: number }, leg: OptionLeg): number {
  if (t.type === 'STO' || t.type === 'STC') return t.contracts * (t.price ?? 0) * 100 - (t.fees || 0);
  if (t.type === 'BTC' || t.type === 'BTO') return -(t.contracts * (t.price ?? 0) * 100 + (t.fees || 0));
  if (t.type === 'ASSIGNED') {
    // Call assignment sells shares at the strike (cash in); put assignment
    // buys shares at the strike (cash out).
    const gross = t.contracts * (t.strike ?? 0) * 100;
    return leg === 'put' ? -(gross + (t.fees || 0)) : gross - (t.fees || 0);
  }
  return 0; // EXPIRED
}

interface Draft {
  type: OptionTxnType;
  date: string;
  contracts: string;
  strike: string;
  expiration: string;
  price: string;
  fees: string;
  note: string;
}

export default function OptionLedgerPanel({
  position,
  leg = 'call',
  title,
  openShortContracts,
  openLongContracts,
  lastExpiration,
}: {
  position: Position;
  leg?: OptionLeg;
  /** Override the default "Short {Call/Put} Ledger" heading — used where the
   *  ledger also holds a long leg (spreads), so "Short" alone undersells it. */
  title?: string;
  openShortContracts: number;
  openLongContracts?: number;
  lastExpiration: string | null;
}) {
  const { addOptionTxn, updateTxn, deleteTxn } = usePositions();
  const confirm = useConfirm();
  const [type, setType] = useState<OptionTxnType>('STO');
  const [date, setDate] = useState(todayStr());
  const [contracts, setContracts] = useState('');
  const [strike, setStrike] = useState('');
  const [expiration, setExpiration] = useState('');
  const [price, setPrice] = useState('');
  const [fees, setFees] = useState('0');
  const [note, setNote] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const showStrike = type !== 'BTC' && type !== 'STC';
  const showExpiration = type === 'STO' || type === 'BTO';
  const showPrice = PRICED_TYPES.includes(type);
  const strikeRequired = type === 'STO' || type === 'BTO' || type === 'ASSIGNED';

  const draftShowStrike = draft ? draft.type !== 'BTC' && draft.type !== 'STC' : false;
  const draftShowExpiration = draft ? draft.type === 'STO' || draft.type === 'BTO' : false;
  const draftShowPrice = draft ? PRICED_TYPES.includes(draft.type) : false;

  const source = leg === 'put' ? position.putTxns : position.optionTxns;
  const txns = [...source].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const legLabel = leg === 'put' ? 'Put' : 'Call';

  function resetForm() {
    setType('STO');
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
    addOptionTxn(
      position.id,
      {
        type,
        date,
        contracts: num(contracts),
        strike: showStrike && strike ? num(strike) : null,
        expiration: showExpiration && expiration ? expiration : null,
        price: showPrice ? num(price) : null,
        fees: num(fees),
        note: note.trim(),
      },
      leg
    );
    resetForm();
  }

  function startEdit(t: OptionTxn) {
    setEditingId(t.id);
    setDraft({
      type: t.type,
      date: t.date,
      contracts: String(t.contracts),
      strike: t.strike != null ? String(t.strike) : '',
      expiration: t.expiration ?? '',
      price: t.price != null ? String(t.price) : '',
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
    const dShowStrike = draft.type !== 'BTC' && draft.type !== 'STC';
    const dShowExpiration = draft.type === 'STO' || draft.type === 'BTO';
    const dShowPrice = PRICED_TYPES.includes(draft.type);
    updateTxn(position.id, leg === 'put' ? 'put' : 'option', editingId, {
      type: draft.type,
      date: draft.date,
      contracts: num(draft.contracts),
      strike: dShowStrike && draft.strike ? num(draft.strike) : null,
      expiration: dShowExpiration && draft.expiration ? draft.expiration : null,
      price: dShowPrice && draft.price ? num(draft.price) : null,
      fees: num(draft.fees),
      note: draft.note.trim(),
    });
    cancelEdit();
  }

  return (
    <div className="panel">
      <h3>{title ?? `Short ${legLabel} Ledger`}</h3>
      <p className="hint">
        {openShortContracts ? `Open short: ${fmtNum(openShortContracts)} contract(s)` : 'No open short contracts.'}
        {openLongContracts != null &&
          (openLongContracts ? ` · Open long: ${fmtNum(openLongContracts)} contract(s)` : ' · No open long contracts.')}
        {lastExpiration ? ` · most recent expiration used: ${fmtDate(lastExpiration)}` : ''}
      </p>

      {txns.length === 0 ? (
        <p className="hint">No option transactions yet.</p>
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
                      onChange={(e) => setDraft({ ...draft, type: e.target.value as OptionTxnType })}
                    >
                      <option value="STO">Sell to Open</option>
                      <option value="BTC">Buy to Close</option>
                      <option value="BTO">Buy to Open (long)</option>
                      <option value="STC">Sell to Close (long)</option>
                      <option value="EXPIRED">Expired Worthless</option>
                      <option value="ASSIGNED">Assigned</option>
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
                    {draftShowStrike ? (
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="inline-edit inline-edit-num"
                        value={draft.strike}
                        onChange={(e) => setDraft({ ...draft, strike: e.target.value })}
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {draftShowExpiration ? (
                      <input
                        type="date"
                        className="inline-edit inline-edit-date"
                        value={draft.expiration}
                        onChange={(e) => setDraft({ ...draft, expiration: e.target.value })}
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {draftShowPrice ? (
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="inline-edit inline-edit-num"
                        value={draft.price}
                        onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                      />
                    ) : (
                      '—'
                    )}
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
                      rowCashFlow(
                        {
                          type: draft.type,
                          contracts: num(draft.contracts),
                          strike: draft.strike ? num(draft.strike) : null,
                          price: draft.price ? num(draft.price) : null,
                          fees: num(draft.fees),
                        },
                        leg
                      )
                    )}
                  >
                    {fmtMoney(
                      rowCashFlow(
                        {
                          type: draft.type,
                          contracts: num(draft.contracts),
                          strike: draft.strike ? num(draft.strike) : null,
                          price: draft.price ? num(draft.price) : null,
                          fees: num(draft.fees),
                        },
                        leg
                      )
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
                    <span className={`chip ${OPTION_TYPE_CLASS[t.type]}`}>{OPTION_TYPE_LABEL[t.type]}</span>
                  </td>
                  <td>{fmtNum(t.contracts)}</td>
                  <td>{t.strike != null ? fmtMoney(t.strike) : '—'}</td>
                  <td>{t.expiration ? fmtDate(t.expiration) : '—'}</td>
                  <td>{PRICED_TYPES.includes(t.type) ? fmtMoney(t.price) : '—'}</td>
                  <td>{fmtMoney(t.fees || 0)}</td>
                  <td className={plClass(rowCashFlow(t, leg))}>{fmtMoney(rowCashFlow(t, leg))}</td>
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
                          deleteTxn(position.id, leg === 'put' ? 'put' : 'option', t.id);
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
            <select value={type} onChange={(e) => setType(e.target.value as OptionTxnType)}>
              <option value="STO">Sell to Open</option>
              <option value="BTC">Buy to Close</option>
              <option value="BTO">Buy to Open (long leg)</option>
              <option value="STC">Sell to Close (long leg)</option>
              <option value="EXPIRED">Expired Worthless</option>
              <option value="ASSIGNED">Assigned</option>
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
        </div>
        <div className="form-row">
          {showStrike && (
            <label className="field">
              <span>Strike</span>
              <input
                type="number"
                min="0"
                step="0.01"
                required={strikeRequired}
                value={strike}
                onChange={(e) => setStrike(e.target.value)}
              />
            </label>
          )}
          {showExpiration && (
            <label className="field">
              <span>Expiration</span>
              <input type="date" required value={expiration} onChange={(e) => setExpiration(e.target.value)} />
            </label>
          )}
          {showPrice && (
            <label className="field">
              <span>{type === 'BTC' ? 'Price Paid to Close/Share' : 'Premium Received/Share'}</span>
              <input type="number" min="0" step="0.01" required value={price} onChange={(e) => setPrice(e.target.value)} />
            </label>
          )}
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
            Add Option Transaction
          </button>
        </div>
      </form>
    </div>
  );
}
