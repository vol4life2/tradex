import { useMemo, useState } from 'react';
import Modal from './Modal';
import { usePositions } from '../context/PositionsContext';
import { useToast } from '../context/ToastContext';
import { parseSchwabCsv } from '../lib/schwabCsv';
import type { ParsedImport, TickerPlan } from '../lib/schwabCsv';
import { parseTastytradeCsv, detectCsvFormat } from '../lib/tastytradeCsv';
import { computePositionMetrics } from '../lib/calc';
import { fmtDate } from '../lib/format';
import { STRATEGY_LABEL, positionStrategyLabel } from '../lib/strategyLabel';
import type { ImportTarget } from '../context/PositionsContext';
import type { Position, Strategy } from '../types';

type BrokerFormat = 'schwab' | 'tastytrade';

const BROKER_LABEL: Record<BrokerFormat, string> = { schwab: 'Schwab', tastytrade: 'tastytrade' };
const BROKER_HELP: Record<BrokerFormat, string> = {
  schwab: 'transaction-history export (Accounts → History → Export)',
  tastytrade: 'gain/loss tax worksheet (Monitor → Tax → Gain/Loss)',
};

const NEW_CHOICE = 'new';
const mergeChoice = (id: string) => `merge:${id}`;

function describePosition(p: Position): string {
  const m = computePositionMetrics(p);
  // The name (not just the strategy) is what actually lets two candidates
  // for the same ticker be told apart here — that's the whole reason a
  // position gets one automatically.
  return `${p.name ?? positionStrategyLabel(p)} · ${m.fullyClosed ? 'closed' : 'open'}`;
}

/** Same idea as strangleKindLabel, for a not-yet-saved import plan (which
 *  uses `callTxns` instead of Position's `optionTxns`). */
function strangleTickerPlanLabel(p: TickerPlan): string {
  const hasPuts = p.putTxns.length > 0;
  const hasCalls = p.callTxns.length > 0;
  if (hasPuts && !hasCalls) return 'Short Put';
  if (hasCalls && !hasPuts) return 'Naked Call';
  return 'Strangle';
}

export default function ImportCsvModal({ onClose }: { onClose: () => void }) {
  const { positions, applyImport } = usePositions();
  const { toast } = useToast();
  const [format, setFormat] = useState<BrokerFormat | null>(null);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [plans, setPlans] = useState<TickerPlan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [targetChoice, setTargetChoice] = useState<Record<string, string>>({});
  // Tickers where the user has touched the Strategy dropdown themselves,
  // as opposed to leaving it at whatever was auto-detected from the CSV.
  // These win outright on import instead of being reclassified afterward.
  const [manualStrategy, setManualStrategy] = useState<Set<string>>(new Set());

  // Existing positions matching each plan's ticker+account — the candidates
  // a ticker's transactions could merge into, besides "create new".
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

  function defaultChoiceFor(ticker: string): string {
    const matches = matchesByTicker.get(ticker) ?? [];
    return matches.length > 0 ? mergeChoice(matches[0].id) : NEW_CHOICE;
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const detected = detectCsvFormat(text);
      if (detected === 'unknown') {
        setError(
          "Couldn't recognize this file's format. Expected a Schwab transaction-history export or a tastytrade gain/loss tax worksheet CSV."
        );
        setParsed(null);
        setPlans([]);
        return;
      }
      setFormat(detected);
      const result = detected === 'tastytrade' ? parseTastytradeCsv(text) : parseSchwabCsv(text);
      if (result.plans.length === 0) {
        setError('No importable trades found in this file.' + (result.skipped.length ? ` ${result.skipped.length} row(s) were skipped — see details below.` : ''));
        setParsed(result);
        setPlans([]);
        return;
      }
      setParsed(result);
      setPlans(result.plans);
      setChecked(new Set(result.plans.map((p) => p.ticker)));
      setTargetChoice({});
      setManualStrategy(new Set());
    } catch (err) {
      setError((err as Error).message);
      setParsed(null);
      setPlans([]);
    } finally {
      e.target.value = '';
    }
  }

  function setStrategy(ticker: string, strategy: Strategy) {
    setPlans((prev) => prev.map((p) => (p.ticker === ticker ? { ...p, strategy } : p)));
    setManualStrategy((prev) => new Set(prev).add(ticker));
  }

  function toggleTicker(ticker: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }

  function toggleAll() {
    setChecked(checked.size === plans.length ? new Set() : new Set(plans.map((p) => p.ticker)));
  }

  function handleConfirm() {
    const includedPlans = plans.filter((p) => checked.has(p.ticker));
    const targets: Record<string, ImportTarget> = {};
    for (const plan of includedPlans) {
      const choice = targetChoice[plan.ticker] ?? defaultChoiceFor(plan.ticker);
      targets[plan.ticker] = choice === NEW_CHOICE ? { mode: 'new' } : { mode: 'merge', positionId: choice.slice('merge:'.length) };
    }
    const strategyOverrides: Record<string, boolean> = {};
    for (const plan of includedPlans) {
      strategyOverrides[plan.ticker] = manualStrategy.has(plan.ticker);
    }
    const summary = applyImport(includedPlans, targets, strategyOverrides);
    toast(
      `Imported ${summary.txnsAdded} transaction(s): ${summary.created} new, ${summary.merged} merged` +
        (summary.duplicatesSkipped ? `, ${summary.duplicatesSkipped} duplicate(s) skipped` : '')
    );
    onClose();
  }

  const txnCount = (p: TickerPlan) =>
    p.stockTxns.length + p.longTxns.length + p.callTxns.length + p.putTxns.length;
  const includedTxnTotal = plans
    .filter((p) => checked.has(p.ticker))
    .reduce((n, p) => n + txnCount(p), 0);
  const allChecked = plans.length > 0 && checked.size === plans.length;

  return (
    <Modal onClose={onClose} wide>
      <div>
        <h2>Import Broker CSV</h2>

        {!parsed && (
          <>
            <p className="hint">
              Drop in either a <strong>Schwab</strong> {BROKER_HELP.schwab} or a <strong>tastytrade</strong>{' '}
              {BROKER_HELP.tastytrade} &mdash; the format is detected automatically. Each becomes ledger entries
              grouped by ticker; positions from different brokers are kept separate even for the same symbol.
              Re-importing the same file is safe &mdash; exact duplicates are skipped.
            </p>
            <label className="btn btn-primary" style={{ marginTop: 12 }}>
              Choose CSV file
              <input type="file" accept=".csv,text/csv" hidden onChange={handleFile} />
            </label>
          </>
        )}

        {error && <div className="banner banner-warn">{error}</div>}

        {parsed && plans.length > 0 && format && (
          <>
            <p className="hint">
              Detected <strong>{BROKER_LABEL[format]}</strong> format &middot; {plans.length} ticker(s) found
              {parsed.ignoredCount ? ` · ${parsed.ignoredCount} non-trade row(s) ignored (dividends, transfers…)` : ''}
              {parsed.skipped.length ? ` · ${parsed.skipped.length} row(s) skipped` : ''}
              &middot; uncheck any ticker you don't want to bring in.
            </p>
            <div className="import-preview">
              <table className="table">
                <thead>
                  <tr>
                    <th className="select-col">
                      <input type="checkbox" checked={allChecked} onChange={toggleAll} title="Select all" />
                    </th>
                    <th>Ticker</th>
                    <th>Strategy</th>
                    <th>Txns</th>
                    <th>Date Range</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => {
                    const matches = matchesByTicker.get(p.ticker) ?? [];
                    const choice = targetChoice[p.ticker] ?? defaultChoiceFor(p.ticker);
                    const isChecked = checked.has(p.ticker);
                    return (
                      <tr key={p.ticker} style={{ opacity: isChecked ? 1 : 0.45 }}>
                        <td className="select-col">
                          <input type="checkbox" checked={isChecked} onChange={() => toggleTicker(p.ticker)} />
                        </td>
                        <td className="ticker-cell">{p.ticker}</td>
                        <td>
                          <select
                            value={p.strategy}
                            onChange={(e) => setStrategy(p.ticker, e.target.value as Strategy)}
                            title={p.warnings.join(' ')}
                            disabled={!isChecked}
                          >
                            {(
                              [
                                'stock',
                                'covered_call',
                                'diagonal',
                                'put_diagonal',
                                'credit_vertical',
                                'debit_vertical',
                                'strangle',
                              ] as Strategy[]
                            ).map((s) => (
                              <option key={s} value={s}>
                                {s === 'strangle' ? strangleTickerPlanLabel(p) : STRATEGY_LABEL[s]}
                              </option>
                            ))}
                          </select>
                          {p.warnings.length > 0 && (
                            <span className="chip chip-warn" title={p.warnings.join(' ')}>
                              !
                            </span>
                          )}
                          {manualStrategy.has(p.ticker) && (
                            <span
                              className="chip chip-warn"
                              title="Manually picked — this will not be auto-reclassified after import"
                            >
                              manual
                            </span>
                          )}
                        </td>
                        <td>
                          {txnCount(p)}
                          <span className="hint-inline">
                            {' '}
                            ({p.stockTxns.length} stk, {p.putTxns.length} put, {p.callTxns.length} call
                            {p.longTxns.length ? `, ${p.longTxns.length} long` : ''})
                          </span>
                        </td>
                        <td>
                          {fmtDate(p.firstDate)} &ndash; {fmtDate(p.lastDate)}
                        </td>
                        <td>
                          {matches.length === 0 ? (
                            <span className="chip chip-muted">new position</span>
                          ) : (
                            <select
                              value={choice}
                              disabled={!isChecked}
                              onChange={(e) => setTargetChoice((prev) => ({ ...prev, [p.ticker]: e.target.value }))}
                              title="Choose whether this ticker's transactions merge into an existing position or start a new one"
                            >
                              {matches.map((m) => (
                                <option key={m.id} value={mergeChoice(m.id)}>
                                  Merge: {describePosition(m)}
                                </option>
                              ))}
                              <option value={NEW_CHOICE}>Create new position</option>
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

        {parsed && parsed.skipped.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => setShowSkipped((s) => !s)}>
              {showSkipped ? 'Hide' : 'Show'} {parsed.skipped.length} skipped row(s)
            </button>
            {showSkipped && (
              <ul className="skipped-list">
                {parsed.skipped.map((s, i) => (
                  <li key={i}>
                    <strong>Line {s.line}:</strong> {s.reason}
                    <div className="skipped-raw">{s.raw}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {plans.length > 0 && (
            <button type="button" className="btn btn-primary" disabled={checked.size === 0} onClick={handleConfirm}>
              Import {includedTxnTotal} Transaction(s)
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
