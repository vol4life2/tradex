import { useRef, useState } from 'react';
import { usePositions } from '../context/PositionsContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../context/ConfirmContext';
import { exportToFile, importFromFile } from '../lib/storage';
import NewPositionModal from './NewPositionModal';
import ImportCsvModal from './ImportCsvModal';
import type { Strategy } from '../types';

export default function TopBar({ onPositionCreated }: { onPositionCreated: (id: string) => void }) {
  const { positions, addPosition, setAllPositions, reclassifyAll } = usePositions();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleCreate(ticker: string, strategy: Strategy, notes: string) {
    const p = addPosition(ticker, strategy, notes);
    setShowNew(false);
    onPositionCreated(p.id);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await importFromFile(file);
      // Dismissing the dialog (Escape/backdrop click) always resolves the
      // confirm button to false — so "replace" (the destructive option) must
      // be the explicit confirm action, and "merge" (non-destructive) must be
      // what a plain dismissal falls back to. No existing data means the two
      // options are equivalent, so skip the dialog entirely.
      const replace = positions.length
        ? await confirm(`Import ${imported.length} position(s)?`, {
            title: 'Merge or replace?',
            confirmLabel: 'Replace All',
            cancelLabel: 'Merge',
            danger: true,
          })
        : true;
      setAllPositions(replace ? imported : positions.concat(imported));
      toast('Import complete');
    } catch (err) {
      alert('Could not import that file: ' + (err as Error).message);
    } finally {
      e.target.value = '';
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          {/* The actual PWA app icon file, not a re-approximation — guarantees
              it's always literally the same image. BASE_URL accounts for the
              /tradex/ prefix on GitHub Pages vs / in dev. */}
          <img className="brand-mark" src={`${import.meta.env.BASE_URL}icons/icon-512.png`} alt="" />
          <div>
            <h1>TradeX</h1>
            <p className="subtitle">Trade Tracker</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className="btn btn-ghost"
            title="Download all data as a JSON backup file"
            onClick={() => {
              exportToFile(positions);
              toast('Backup downloaded');
            }}
          >
            Export
          </button>
          <label className="btn btn-ghost" title="Restore from a JSON backup file">
            Import
            <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={handleImport} />
          </label>
          <button
            className="btn btn-ghost"
            title="Import a Schwab transaction-history CSV export"
            onClick={() => setShowCsvImport(true)}
          >
            Import CSV
          </button>
          <button
            className="btn btn-ghost"
            title="Re-check every position's transactions and fix its strategy label if it no longer fits (e.g. a short put that's been assigned and should now say Covered Call). Skips any position where you've manually picked a strategy on its detail page."
            onClick={() => {
              const summary = reclassifyAll();
              toast(
                summary.changed > 0
                  ? `Reclassified ${summary.changed} position(s)`
                  : 'Everything already matches its transactions'
              );
            }}
          >
            Reclassify Strategies
          </button>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            + New Position
          </button>
        </div>
      </div>
      {showNew && <NewPositionModal onClose={() => setShowNew(false)} onCreate={handleCreate} />}
      {showCsvImport && <ImportCsvModal onClose={() => setShowCsvImport(false)} />}
    </header>
  );
}
