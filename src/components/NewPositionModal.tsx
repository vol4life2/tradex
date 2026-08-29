import { useState } from 'react';
import type { FormEvent } from 'react';
import Modal from './Modal';
import type { Strategy } from '../types';

export default function NewPositionModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (ticker: string, strategy: Strategy, notes: string) => void;
}) {
  const [ticker, setTicker] = useState('');
  const [strategy, setStrategy] = useState<Strategy>('covered_call');
  const [notes, setNotes] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ticker.trim()) return;
    onCreate(ticker, strategy, notes);
  }

  return (
    <Modal onClose={onClose}>
      <h2>New Position</h2>
      <form onSubmit={handleSubmit}>
        <label className="field">
          <span>Ticker</span>
          <input
            type="text"
            required
            maxLength={10}
            style={{ textTransform: 'uppercase' }}
            placeholder="e.g. AAPL"
            autoFocus
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Strategy</span>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as Strategy)}>
            <option value="stock">Stock (fewer than 100 shares, no call sold yet)</option>
            <option value="covered_call">Covered Call (own shares — however acquired)</option>
            <option value="diagonal">Call Diagonal / PMCC (long call as stock proxy)</option>
            <option value="put_diagonal">Put Diagonal (long put, calendar-style)</option>
            <option value="credit_vertical">Credit Vertical (short + long, same expiration, net credit)</option>
            <option value="debit_vertical">Debit Vertical (short + long, same expiration, net debit)</option>
            <option value="strangle">Strangle / Naked Short Put or Call (no stock — converts to Covered Call on assignment)</option>
          </select>
        </label>
        <label className="field">
          <span>Notes (optional)</span>
          <textarea
            rows={2}
            placeholder="Anything worth remembering about this position"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Create Position
          </button>
        </div>
      </form>
    </Modal>
  );
}
