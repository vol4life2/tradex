import { useMemo, useState } from 'react';
import Modal from './Modal';
import { usePositions } from '../context/PositionsContext';
import { useToast } from '../context/ToastContext';
import { detectSchwabPositionStatement, parseSchwabPositionStatement } from '../lib/schwabPositionsCsv';
import { detectTastytradePositions, parseTastytradePositions } from '../lib/tastytradePositionsCsv';
import { snapshotToPlans, snapshotToPricingUpdate } from '../lib/positionSnapshot';
import type { SnapshotImport, SnapshotTicker } from '../lib/positionSnapshot';
import { computePositionMetrics } from '../lib/calc';
import { STRATEGY_LABEL, positionStrategyLabel } from '../lib/strategyLabel';
import type { Position } from '../types';
import type { TickerPlan } from '../lib/schwabCsv';

const NEW_CHOICE = 'new';

function describePosition(p: Position): string {
  const m = computePositionMetrics(p);
  return `${p.name ?? positionStrategyLabel(p)} · ${m.fullyClosed ? 'closed' : 'open'}`;
}

/** Same idea as strangleKindLabel, for a not-yet-saved TickerPlan (which uses
 *  `callTxns` instead of Position's `optionTxns`) — mirrors ImportCsvModal's
 *  own strangleTickerPlanLabel helper. */
function planStrategyLabel(p: TickerPlan): string {
  if (p.strategy !== 'strangle') return STRATEGY_LABEL[p.strategy] ?? p.strategy;
  const hasPuts = p.putTxns.length > 0;
  const hasCalls = p.callTxns.length > 0;
  if (hasPuts && !hasCalls) return 'Short Put';
  if (hasCalls && !hasPuts) return 'Naked Call';
  return 'Strangle';
}

export default function PositionSnapshotModal({ onClose }: { onClose: () => void }) {
  const { positions, applyImport, updatePricing } = usePositions();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<SnapshotImport | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [targetChoice, setTargetChoice] = useState<Record<string, string>>({});

  const tickersByName = useMemo(() => {
    const m = new Map<string, SnapshotTicker>();
    if (snap) for (const t of snap.tickers) m.set(t.ticker, t);
    return m;
  }, [snap]);

  // Only tickers that actually have something to do (snapshotToPlans already
  // drops fully-flat ones) — this also gives each ticker its inferred
  // strategy for the "create new" preview, via the exact same finalize pass
  // a real CSV import uses.
  const plans = useMemo(() => (snap ? snapshotToPlans(snap) : []), [snap]);

  // Existing positions matching each ticker+account — candidates to update
  // prices on instead of creating a new position.
  const matchesByTicker = useMemo(() => {
    const map = new Map<string, Position[]>();
    for (const plan of plans) {
      map.set(
        plan.ticker,
        positions.filter(
          (p) => p.ticker.toUpperCase() === plan.ticker.toUpperCase() && (p.account ?? null) === (plan.account ?? null)
        )
      );
    }
    return map;
  }, [plans, positions]);

  // Defaulting to matches[0] regardless of status used to silently pick a
  // long-CLOSED position for a ticker that's actually back open again (a new
  // campaign) — "update prices" on a closed position is a no-op (no leg is
  // still open to match against), so the snapshot's real open position never
  // got created and just looked like it vanished. Only auto-default to an
  // existing match if it's still open; a ticker with only closed matches
  // defaults to creating a new position instead (the user can still pick the
  // closed one manually from the dropdown if that's really what they want).
  function defaultChoiceFor(ticker: string): string {
    const matches = matchesByTicker.get(ticker) ?? [];
    const openMatch = matches.find((p) => !computePositionMetrics(p).fullyClosed);
    return openMatch ? openMatch.id : NEW_CHOICE;
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      let parsed: SnapshotImport;
      if (detectSchwabPositionStatement(text)) {
        parsed = parseSchwabPositionStatement(text);
      } else if (detectTastytradePositions(text)) {
        parsed = parseTastytradePositions(text);
      } else {
        setError(
          "Couldn't recognize this file's format. Expected a Schwab Position Statement or a tastytrade Positions-tab export (not a transaction history — use Import CSV for that)."
        );
        setSnap(null);
        return;
      }
      if (parsed.tickers.length === 0) {
        setError('No open positions found in this file.');
        setSnap(null);
        return;
      }
      setSnap(parsed);
      setChecked(new Set(parsed.tickers.map((t) => t.ticker)));
      setTargetChoice({});
    } catch (err) {
      setError((err as Error).message);
      setSnap(null);
    } finally {
      e.target.value = '';
    }
  }

  function toggleTicker(ticker: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }

  function handleConfirm() {
    if (!snap) return;
    const includedPlans = plans.filter((p) => checked.has(p.ticker));

    const toCreate = includedPlans.filter((p) => (targetChoice[p.ticker] ?? defaultChoiceFor(p.ticker)) === NEW_CHOICE);
    const toUpdate = includedPlans.filter((p) => (targetChoice[p.ticker] ?? defaultChoiceFor(p.ticker)) !== NEW_CHOICE);

    // applyImport MUST run before any updatePricing calls below, not after.
    // It computes its next state synchronously off the outer-scope
    // `positions` closure and calls setPositions with that plain array
    // (deliberately, per its own comment, to keep summary counts correct
    // under StrictMode's double-invoke) — a plain-value setState call
    // replaces whatever's pending in the batch rather than folding into it,
    // so an updatePricing queued BEFORE it here would get silently
    // discarded. Queued after, updatePricing's functional updater correctly
    // receives applyImport's just-set array as its `prev`.
    let createdCount = 0;
    if (toCreate.length > 0) {
      const targets = Object.fromEntries(toCreate.map((p) => [p.ticker, { mode: 'new' as const }]));
      const summary = applyImport(toCreate, targets, {});
      createdCount = summary.created;
    }

    let updatedCount = 0;
    for (const plan of toUpdate) {
      const positionId = targetChoice[plan.ticker] ?? defaultChoiceFor(plan.ticker);
      const position = positions.find((p) => p.id === positionId);
      const snapshotTicker = tickersByName.get(plan.ticker);
      if (!position || !snapshotTicker) continue;
      const fields = snapshotToPricingUpdate(position, snapshotTicker);
      if (Object.keys(fields).length > 0) {
        updatePricing(positionId, fields);
        updatedCount++;
      }
    }

    const parts = [];
    if (updatedCount > 0) parts.push(`updated prices on ${updatedCount}`);
    if (createdCount > 0) parts.push(`created ${createdCount} new position(s)`);
    toast(parts.length > 0 ? parts.join(', ') : 'Nothing to apply');
    onClose();
  }

  const includedCount = plans.filter((p) => checked.has(p.ticker)).length;

  return (
    <Modal onClose={onClose} wide>
      <div>
        <h2>Update from Positions Snapshot</h2>

        {!snap && (
          <>
            <p className="hint">
              For a quick refresh instead of a full transaction history: drop in a <strong>Schwab Position
              Statement</strong> or a <strong>tastytrade Positions</strong>-tab export — both are a snapshot of what's
              open <em>right now</em>, with current mark prices. A ticker that already has a position here gets its
              Pricing panel refreshed (nothing in its transaction history is touched). A ticker with no existing
              position gets created fresh from the snapshot — quantities/strikes/prices are real, but the entry date
              isn't (a snapshot has no history), so review and correct it after.
            </p>
            <label className="btn btn-primary" style={{ marginTop: 12 }}>
              Choose CSV file
              <input type="file" accept=".csv,text/csv" hidden onChange={handleFile} />
            </label>
          </>
        )}

        {error && <div className="banner banner-warn">{error}</div>}

        {snap && plans.length > 0 && (
          <>
            <p className="hint">
              {plans.length} ticker(s) with open positions found
              {snap.asOfDate ? ` as of ${snap.asOfDate}` : ''} · uncheck any you don't want to touch.
            </p>
            <div className="import-preview">
              <table className="table">
                <thead>
                  <tr>
                    <th className="select-col"></th>
                    <th>Ticker</th>
                    <th>Legs</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => {
                    const matches = matchesByTicker.get(p.ticker) ?? [];
                    const choice = targetChoice[p.ticker] ?? defaultChoiceFor(p.ticker);
                    const isChecked = checked.has(p.ticker);
                    const legCount =
                      p.stockTxns.length + p.longTxns.length + p.callTxns.length + p.putTxns.length;
                    return (
                      <tr key={p.ticker} style={{ opacity: isChecked ? 1 : 0.45 }}>
                        <td className="select-col">
                          <input type="checkbox" checked={isChecked} onChange={() => toggleTicker(p.ticker)} />
                        </td>
                        <td className="ticker-cell">{p.ticker}</td>
                        <td>
                          {legCount} leg(s)
                          {choice === NEW_CHOICE && <span className="hint-inline"> ({planStrategyLabel(p)})</span>}
                        </td>
                        <td>
                          {matches.length === 0 ? (
                            <span className="chip chip-muted">new position</span>
                          ) : (
                            <select
                              value={choice}
                              disabled={!isChecked}
                              onChange={(e) => setTargetChoice((prev) => ({ ...prev, [p.ticker]: e.target.value }))}
                              title="Update prices on an existing position, or create a new one instead"
                            >
                              {matches.map((m) => (
                                <option key={m.id} value={m.id}>
                                  Update prices: {describePosition(m)}
                                </option>
                              ))}
                              <option value={NEW_CHOICE}>Create new position instead</option>
                            </select>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {snap && plans.length > 0 && (
            <button type="button" className="btn btn-primary" disabled={includedCount === 0} onClick={handleConfirm}>
              Apply to {includedCount} Ticker(s)
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
