import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePositions } from '../context/PositionsContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../context/ConfirmContext';
import { exportToFile, importFromFile } from '../lib/storage';
import { ALL_ACCOUNTS, NO_ACCOUNT, type StatusFilter } from '../lib/filters';
import ImportCsvModal from './ImportCsvModal';

export default function TopBar({
  accountFilter,
  setAccountFilter,
  statusFilter,
  setStatusFilter,
  showFilters,
}: {
  accountFilter: string;
  setAccountFilter: (v: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (v: StatusFilter) => void;
  showFilters: boolean;
}) {
  const { positions, setAllPositions, reclassifyAll } = usePositions();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Distinct accounts seen across all positions, for the filter dropdown.
  const accounts = useMemo(() => {
    const set = new Set<string>();
    for (const p of positions) set.add(p.account ?? NO_ACCOUNT);
    return [...set].sort();
  }, [positions]);

  // Reset to "All Accounts" if the selected account no longer exists (e.g.
  // its last position got deleted) rather than silently showing zero rows.
  useEffect(() => {
    if (accountFilter !== ALL_ACCOUNTS && !accounts.includes(accountFilter)) {
      setAccountFilter(ALL_ACCOUNTS);
    }
  }, [accountFilter, accounts, setAccountFilter]);

  useEffect(() => {
    if (!showMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMenu(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showMenu]);

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

  const modalRoot = document.getElementById('modal-root');

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
        <div className="topbar-controls">
          {showFilters && (
            <>
              {accounts.length > 1 && (
                <select
                  className="header-select"
                  value={accountFilter}
                  onChange={(e) => setAccountFilter(e.target.value)}
                  title="Filter by account"
                >
                  <option value={ALL_ACCOUNTS}>All Accounts</option>
                  {accounts.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              )}
              <select
                className="header-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                title="Filter by status"
              >
                <option value="all">All Positions</option>
                <option value="open">Open Only</option>
                <option value="closed">Closed Only</option>
              </select>
            </>
          )}
          <button
            className="btn btn-ghost btn-icon hamburger-btn"
            title="Menu"
            aria-label="Open menu"
            onClick={() => setShowMenu(true)}
          >
            ☰
          </button>
        </div>
      </div>

      {showCsvImport && <ImportCsvModal onClose={() => setShowCsvImport(false)} />}

      {/* Portal into #modal-root, same reason Modal.tsx does: the topbar's
          own backdrop-filter would otherwise become the containing block for
          a `position: fixed` drawer, boxing it into the topbar's short
          height instead of the full viewport (see Modal.tsx's comment). */}
      {showMenu &&
        modalRoot &&
        createPortal(
          <>
            <div className="drawer-backdrop" onClick={() => setShowMenu(false)} />
            <nav className="drawer" aria-label="App menu">
              <div className="drawer-header">
                <span>Menu</span>
                <button className="btn btn-ghost btn-icon" onClick={() => setShowMenu(false)} aria-label="Close menu">
                  ✕
                </button>
              </div>
              <button
                className="btn btn-ghost"
                title="Download all data as a JSON backup file"
                onClick={() => {
                  exportToFile(positions);
                  toast('Backup downloaded');
                  setShowMenu(false);
                }}
              >
                Export
              </button>
              <label className="btn btn-ghost" title="Restore from a JSON backup file">
                Import
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json"
                  hidden
                  onChange={(e) => {
                    handleImport(e);
                    setShowMenu(false);
                  }}
                />
              </label>
              <button
                className="btn btn-ghost"
                title="Import a Schwab transaction-history CSV export"
                onClick={() => {
                  setShowCsvImport(true);
                  setShowMenu(false);
                }}
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
                  setShowMenu(false);
                }}
              >
                Reclassify Strategies
              </button>
            </nav>
          </>,
          modalRoot
        )}
    </header>
  );
}
