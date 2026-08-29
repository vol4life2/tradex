/* storage.ts — localStorage persistence + JSON export/import */
import type { Position } from '../types';
import { inferStrategy, promoteSameExpirationSpreads } from './strategyInference';
import { positionStrategyLabel } from './strategyLabel';
import { fmtDate } from './format';

const KEY = 'cc-diagonal-tracker/v1';

function positionHasAnyTxns(p: Position): boolean {
  return (
    (p.stockTxns?.length ?? 0) > 0 ||
    (p.longTxns?.length ?? 0) > 0 ||
    (p.optionTxns?.length ?? 0) > 0 ||
    (p.putTxns?.length ?? 0) > 0
  );
}

function earliestTxnDate(p: Position): string | null {
  const dates = [
    ...(p.stockTxns ?? []).map((t) => t.date),
    ...(p.longTxns ?? []).map((t) => t.date),
    ...(p.optionTxns ?? []).map((t) => t.date),
    ...(p.putTxns ?? []).map((t) => t.date),
  ];
  return dates.length > 0 ? dates.sort()[0] : null;
}

/** "TICKER — Strategy Label (Start Date)" — see the `name` doc on Position
 *  for why every position gets one, not just ones that need disambiguating:
 *  it's also what the CSV-import merge-target picker shows, so a name needs
 *  to exist and be meaningful before there's ever a second position on the
 *  same ticker to tell apart. No date suffix for a position with no
 *  transactions yet (nothing to date it by). */
export function autoPositionName(p: Position): string {
  const label = positionStrategyLabel(p);
  const start = earliestTxnDate(p);
  return start ? `${p.ticker} — ${label} (${fmtDate(start)})` : `${p.ticker} — ${label}`;
}

/**
 * Re-derive a position's strategy AND name from its actual transactions,
 * correcting either if they no longer fit — e.g. positions saved under an
 * earlier, cruder version of the inference logic that called anything with
 * a put leg "wheel" even when it was really a put spread or a strangle, or
 * a name that's gone stale because the strategy (and therefore the name
 * that describes it) changed. Positions with zero transactions have their
 * strategy left alone (nothing to infer, and it would clobber a deliberate
 * manual choice on a not-yet-populated position) but still get an initial
 * name. `strategyOverride` / `nameOverride` each independently opt their
 * field out of this — the user picked that value deliberately via its own
 * dropdown/edit control, so auto-detection backs off for that field even if
 * the transaction shape doesn't match its own guess.
 *
 * Exception: a position still carrying an old, no-longer-selectable strategy
 * string — 'spread' (split into credit_vertical/debit_vertical) or 'wheel'
 * (folded into covered_call/strangle) — is always migrated, even past a
 * manual override, since leaving it in place would point the position at a
 * value nothing in the UI can render.
 */
const LEGACY_STRATEGY_DEFAULTS: Record<string, Position['strategy']> = {
  spread: 'credit_vertical',
  wheel: 'covered_call',
};

export function reclassifyPosition(p: Position): { position: Position; changed: boolean } {
  const legacyDefault = LEGACY_STRATEGY_DEFAULTS[p.strategy as string];
  const isLegacyStrategy = legacyDefault !== undefined;
  const strategyLocked = p.strategyOverride && !isLegacyStrategy;

  let withStrategy: Position = p;
  let strategyChanged = false;

  if (!strategyLocked) {
    if (!positionHasAnyTxns(p)) {
      if (isLegacyStrategy) {
        withStrategy = { ...p, strategy: legacyDefault, strategyOverride: false };
        strategyChanged = true;
      }
    } else {
      const promoted = promoteSameExpirationSpreads(
        p.longTxns ?? [],
        p.optionTxns ?? [],
        p.putTxns ?? [],
        (t, type) => ({ ...t, type })
      );
      const inferred = inferStrategy({
        stockTxns: p.stockTxns ?? [],
        longTxns: promoted.longTxns,
        callTxns: promoted.callTxns,
        putTxns: promoted.putTxns,
      });
      const changed = inferred.strategy !== p.strategy || promoted.promoted || isLegacyStrategy;
      if (changed) {
        withStrategy = {
          ...p,
          strategy: inferred.strategy,
          longTxns: promoted.longTxns,
          optionTxns: promoted.callTxns,
          putTxns: promoted.putTxns,
          ...(isLegacyStrategy ? { strategyOverride: false } : {}),
        };
        strategyChanged = true;
      }
    }
  }

  let nameChanged = false;
  let withName = withStrategy;
  if (!withStrategy.nameOverride) {
    const auto = autoPositionName(withStrategy);
    if (withStrategy.name !== auto) {
      withName = { ...withStrategy, name: auto };
      nameChanged = true;
    }
  }

  if (!strategyChanged && !nameChanged) return { position: p, changed: false };
  return { position: withName, changed: true };
}

/** Positions saved before the `account` field existed: if their transactions
 *  came from the Schwab importer, tag them Schwab so future Schwab imports
 *  keep merging into them (and tastytrade imports of the same ticker don't). */
function detectLegacyAccount(p: Position): string | null {
  const allTxns = [
    ...(p.stockTxns ?? []),
    ...(p.longTxns ?? []),
    ...(p.optionTxns ?? []),
    ...(p.putTxns ?? []),
  ];
  return allTxns.some((t) => (t.note || '').includes('Imported') || (t.note || '').includes('(imported)'))
    ? 'Schwab'
    : null;
}

/** Fill in fields added after a position was saved (older saves / vanilla-app backups),
 *  then self-heal its strategy label against its actual transactions. */
export function normalizePosition(p: Position): Position {
  const filled: Position = {
    ...p,
    account: p.account !== undefined ? p.account : detectLegacyAccount(p),
    stockTxns: p.stockTxns ?? [],
    longTxns: p.longTxns ?? [],
    optionTxns: p.optionTxns ?? [],
    putTxns: p.putTxns ?? [],
    currentPrice: p.currentPrice ?? null,
    currentLongValue: p.currentLongValue ?? null,
    currentShortValue: p.currentShortValue ?? null,
    currentPutValue: p.currentPutValue ?? null,
  };
  return reclassifyPosition(filled).position;
}

export function loadPositions(): Position[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizePosition) : [];
  } catch (e) {
    console.error('Failed to load saved data', e);
    return [];
  }
}

export function savePositions(positions: Position[]): void {
  localStorage.setItem(KEY, JSON.stringify(positions));
}

export function exportToFile(positions: Position[]): void {
  const payload = {
    app: 'covered-call-diagonal-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    positions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `cost-basis-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function importFromFile(file: File): Promise<Position[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        const positions = Array.isArray(parsed) ? parsed : parsed.positions;
        if (!Array.isArray(positions)) throw new Error('File does not contain a positions array.');
        resolve(positions.map(normalizePosition));
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
