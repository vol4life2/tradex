import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LongTxn, OptionTxn, Position, StockTxn, Strategy } from '../types';
import { inferStrategy, promoteSameExpirationSpreads } from '../lib/strategyInference';
import { autoPositionName, loadPositions, reclassifyPosition, savePositions } from '../lib/storage';
import { todayStr, uid } from '../lib/format';
import type { TickerPlan } from '../lib/schwabCsv';

type TxnKind = 'stock' | 'long' | 'option' | 'put';
export type OptionLeg = 'call' | 'put';

export interface ImportSummary {
  created: number;
  merged: number;
  txnsAdded: number;
  duplicatesSkipped: number;
}

export interface ReclassifySummary {
  changed: number;
  unchanged: number;
}

/** Per-ticker override for where an imported plan's transactions should land.
 *  'auto' (default when omitted) keeps the old behavior: match an existing
 *  position by ticker+account, else create new. 'new' forces a fresh
 *  position even if a match exists — for when a ticker's activity has moved
 *  on to a genuinely different campaign (e.g. SLV: an old, fully-closed
 *  strangle vs. a new diagonal) that shouldn't be blended into the same
 *  position. 'merge' targets one specific existing position by id, for when
 *  more than one already exists for that ticker (after a prior split, say). */
export type ImportTarget = { mode: 'auto' } | { mode: 'new' } | { mode: 'merge'; positionId: string };

export interface SplitSelection {
  stockTxnIds: string[];
  longTxnIds: string[];
  optionTxnIds: string[];
  putTxnIds: string[];
}

interface PositionsContextValue {
  positions: Position[];
  addPosition: (ticker: string, strategy: Strategy, notes: string) => Position;
  deletePosition: (id: string) => void;
  deletePositions: (ids: string[]) => void;
  addStockTxn: (positionId: string, txn: Omit<StockTxn, 'id'>) => void;
  addLongTxn: (positionId: string, txn: Omit<LongTxn, 'id'>) => void;
  addOptionTxn: (positionId: string, txn: Omit<OptionTxn, 'id'>, leg?: OptionLeg) => void;
  deleteTxn: (positionId: string, kind: TxnKind, txnId: string) => void;
  /** Edits a transaction's fields in place, instead of deleting and
   *  re-adding it — keeps its id and doesn't require retyping the whole
   *  row to fix one wrong value (common right after a CSV import). */
  updateTxn: (positionId: string, kind: TxnKind, txnId: string, fields: Record<string, unknown>) => void;
  updatePricing: (
    positionId: string,
    fields: Partial<
      Pick<Position, 'currentPrice' | 'currentLongValue' | 'currentShortValue' | 'currentPutValue'>
    >
  ) => void;
  updateNotes: (positionId: string, notes: string) => void;
  /** Manually picks a strategy from the dropdown. Marks the position with
   *  `strategyOverride` so auto-reclassification leaves it alone afterward. */
  setStrategy: (positionId: string, strategy: Strategy) => void;
  /** Clears a manual override and immediately re-infers from the actual
   *  transactions, going back to normal auto-detected behavior. */
  resetStrategyToAuto: (positionId: string) => void;
  /** Manually renames a position. Marks it with `nameOverride` so auto-
   *  naming stops touching it — same pattern as setStrategy. */
  setName: (positionId: string, name: string) => void;
  /** Clears a manual rename and immediately regenerates "TICKER — Strategy
   *  (start date)" from the position's current data. */
  resetNameToAuto: (positionId: string) => void;
  setAllPositions: (positions: Position[]) => void;
  applyImport: (
    plans: TickerPlan[],
    targets?: Record<string, ImportTarget>,
    strategyOverrides?: Record<string, boolean>
  ) => ImportSummary;
  reclassifyAll: () => ReclassifySummary;
  /** Moves the given transaction ids out of `positionId`, either into a
   *  brand-new position (same ticker/account, strategy re-inferred from what
   *  moved) or, when `targetPositionId` is given, merged into that existing
   *  position (also re-inferring its strategy from the combined ledgers).
   *  Returns the destination position's id, or null if nothing was selected,
   *  the source position wasn't found, or the target position wasn't found.
   *  If nothing is left behind in the source, it is removed rather than left
   *  as an empty husk. */
  splitPosition: (positionId: string, selection: SplitSelection, targetPositionId?: string) => string | null;
}

const PositionsContext = createContext<PositionsContextValue | null>(null);

export function PositionsProvider({ children }: { children: ReactNode }) {
  const [positions, setPositions] = useState<Position[]>(() => loadPositions());

  useEffect(() => {
    savePositions(positions);
  }, [positions]);

  const addPosition = useCallback((ticker: string, strategy: Strategy, notes: string) => {
    const p: Position = {
      id: uid(),
      ticker: ticker.trim().toUpperCase(),
      strategy,
      account: null,
      notes: notes.trim(),
      createdDate: todayStr(),
      stockTxns: [],
      longTxns: [],
      optionTxns: [],
      putTxns: [],
      currentPrice: null,
      currentLongValue: null,
      currentShortValue: null,
      currentPutValue: null,
    };
    p.name = autoPositionName(p);
    setPositions((prev) => [...prev, p]);
    return p;
  }, []);

  const deletePosition = useCallback((id: string) => {
    setPositions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const deletePositions = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setPositions((prev) => prev.filter((p) => !idSet.has(p.id)));
  }, []);

  const addStockTxn = useCallback((positionId: string, txn: Omit<StockTxn, 'id'>) => {
    setPositions((prev) =>
      prev.map((p) => (p.id === positionId ? { ...p, stockTxns: [...p.stockTxns, { ...txn, id: uid() }] } : p))
    );
  }, []);

  const addLongTxn = useCallback((positionId: string, txn: Omit<LongTxn, 'id'>) => {
    setPositions((prev) =>
      prev.map((p) => (p.id === positionId ? { ...p, longTxns: [...p.longTxns, { ...txn, id: uid() }] } : p))
    );
  }, []);

  const addOptionTxn = useCallback((positionId: string, txn: Omit<OptionTxn, 'id'>, leg: OptionLeg = 'call') => {
    const key = leg === 'put' ? 'putTxns' : 'optionTxns';
    setPositions((prev) =>
      prev.map((p) => (p.id === positionId ? { ...p, [key]: [...p[key], { ...txn, id: uid() }] } : p))
    );
  }, []);

  const deleteTxn = useCallback((positionId: string, kind: TxnKind, txnId: string) => {
    setPositions((prev) =>
      prev.map((p) => {
        if (p.id !== positionId) return p;
        if (kind === 'stock') return { ...p, stockTxns: p.stockTxns.filter((t) => t.id !== txnId) };
        if (kind === 'long') return { ...p, longTxns: p.longTxns.filter((t) => t.id !== txnId) };
        if (kind === 'put') return { ...p, putTxns: p.putTxns.filter((t) => t.id !== txnId) };
        return { ...p, optionTxns: p.optionTxns.filter((t) => t.id !== txnId) };
      })
    );
  }, []);

  const updateTxn = useCallback(
    (positionId: string, kind: TxnKind, txnId: string, fields: Record<string, unknown>) => {
      setPositions((prev) =>
        prev.map((p) => {
          if (p.id !== positionId) return p;
          const patch = <T extends { id: string }>(arr: T[]): T[] =>
            arr.map((t) => (t.id === txnId ? { ...t, ...fields } : t));
          if (kind === 'stock') return { ...p, stockTxns: patch(p.stockTxns) };
          if (kind === 'long') return { ...p, longTxns: patch(p.longTxns) };
          if (kind === 'put') return { ...p, putTxns: patch(p.putTxns) };
          return { ...p, optionTxns: patch(p.optionTxns) };
        })
      );
    },
    []
  );

  const updatePricing = useCallback(
    (
      positionId: string,
      fields: Partial<
        Pick<Position, 'currentPrice' | 'currentLongValue' | 'currentShortValue' | 'currentPutValue'>
      >
    ) => {
      setPositions((prev) => prev.map((p) => (p.id === positionId ? { ...p, ...fields } : p)));
    },
    []
  );

  const updateNotes = useCallback((positionId: string, notes: string) => {
    setPositions((prev) => prev.map((p) => (p.id === positionId ? { ...p, notes } : p)));
  }, []);

  const setStrategy = useCallback((positionId: string, strategy: Strategy) => {
    setPositions((prev) =>
      prev.map((p) => {
        if (p.id !== positionId) return p;
        const updated: Position = { ...p, strategy, strategyOverride: true };
        // The name normally describes the strategy ("TICKER — Strategy
        // (date)") — if it hasn't been manually renamed, keep it matching
        // the strategy that was just picked instead of going stale.
        if (!updated.nameOverride) updated.name = autoPositionName(updated);
        return updated;
      })
    );
  }, []);

  const resetStrategyToAuto = useCallback((positionId: string) => {
    setPositions((prev) =>
      prev.map((p) => {
        if (p.id !== positionId) return p;
        const cleared = { ...p, strategyOverride: false };
        // Re-infer right away rather than waiting for the next reload/import,
        // so the dropdown reflects the corrected label immediately.
        const promoted = promoteSameExpirationSpreads(
          cleared.longTxns,
          cleared.optionTxns,
          cleared.putTxns,
          (t, type) => ({ ...t, type })
        );
        const inferred = inferStrategy({
          stockTxns: cleared.stockTxns,
          longTxns: promoted.longTxns,
          callTxns: promoted.callTxns,
          putTxns: promoted.putTxns,
        });
        const updated: Position = {
          ...cleared,
          strategy: inferred.strategy,
          longTxns: promoted.longTxns,
          optionTxns: promoted.callTxns,
          putTxns: promoted.putTxns,
        };
        if (!updated.nameOverride) updated.name = autoPositionName(updated);
        return updated;
      })
    );
  }, []);

  const setName = useCallback((positionId: string, name: string) => {
    setPositions((prev) =>
      prev.map((p) => (p.id === positionId ? { ...p, name: name.trim(), nameOverride: true } : p))
    );
  }, []);

  const resetNameToAuto = useCallback((positionId: string) => {
    setPositions((prev) =>
      prev.map((p) => (p.id === positionId ? { ...p, name: autoPositionName({ ...p, nameOverride: false }), nameOverride: false } : p))
    );
  }, []);

  const setAllPositions = useCallback((next: Position[]) => setPositions(next), []);

  const applyImport = useCallback(
    (
      plans: TickerPlan[],
      targets?: Record<string, ImportTarget>,
      strategyOverrides?: Record<string, boolean>
    ): ImportSummary => {
      const summary: ImportSummary = { created: 0, merged: 0, txnsAdded: 0, duplicatesSkipped: 0 };

      // Exact-duplicate detection so re-importing the same file is harmless.
      const stockKey = (t: Omit<StockTxn, 'id'>) => `${t.type}|${t.date}|${t.shares}|${t.price}|${t.fees}`;
      const optKey = (t: Omit<OptionTxn, 'id'> | Omit<LongTxn, 'id'>) =>
        `${t.type}|${t.date}|${t.contracts}|${'strike' in t ? t.strike : ''}|${t.expiration}|${t.price}|${t.fees}`;

      function mergeInto<T extends { id: string }, U>(
        existing: T[],
        incoming: U[],
        keyOf: (t: U | T) => string,
        makeTxn: (t: U) => T
      ): T[] {
        const seen = new Set(existing.map(keyOf));
        const added: T[] = [];
        for (const t of incoming) {
          const k = keyOf(t);
          if (seen.has(k)) {
            summary.duplicatesSkipped++;
            continue;
          }
          seen.add(k);
          summary.txnsAdded++;
          added.push(makeTxn(t));
        }
        return [...existing, ...added];
      }

      // Compute against current state synchronously (NOT inside a setPositions
      // updater — React may defer or, in StrictMode, double-invoke updaters,
      // which would corrupt the returned summary).
      const next = [...positions];
      for (const plan of plans) {
        const choice = targets?.[plan.ticker] ?? { mode: 'auto' as const };
        let idx = -1;
        if (choice.mode === 'merge') {
          idx = next.findIndex((p) => p.id === choice.positionId);
        } else if (choice.mode === 'auto') {
          // Match on ticker + account, not ticker alone: the same symbol at
          // two brokers is two real positions with two real cost bases, and
          // merging them would corrupt both. ('new' mode skips this lookup
          // entirely, forcing idx to stay -1 so a fresh position is made.)
          idx = next.findIndex(
            (p) => p.ticker.toUpperCase() === plan.ticker.toUpperCase() && (p.account ?? null) === (plan.account ?? null)
          );
        }
        // Did the user deliberately pick a strategy for this ticker in the
        // import preview (as opposed to leaving it at the auto-detected
        // default)? If so it should stick, on both a new position and a
        // merge into an existing one — not get silently reclassified away
        // right after import.
        const manualStrategy = strategyOverrides?.[plan.ticker] ?? false;

        const target: Position =
          idx >= 0
            ? next[idx]
            : {
                id: uid(),
                ticker: plan.ticker,
                strategy: plan.strategy,
                strategyOverride: manualStrategy,
                account: plan.account,
                notes: '',
                createdDate: todayStr(),
                stockTxns: [],
                longTxns: [],
                optionTxns: [],
                putTxns: [],
                currentPrice: null,
                currentLongValue: null,
                currentShortValue: null,
                currentPutValue: null,
              };
        if (idx >= 0) summary.merged++;
        else summary.created++;

        const merged: Position = {
          ...target,
          stockTxns: mergeInto(target.stockTxns, plan.stockTxns, stockKey as (t: unknown) => string, (t) => ({ ...t, id: uid() })),
          longTxns: mergeInto(target.longTxns, plan.longTxns, optKey as (t: unknown) => string, (t) => ({ ...t, id: uid() })),
          optionTxns: mergeInto(target.optionTxns, plan.callTxns, optKey as (t: unknown) => string, (t) => ({ ...t, id: uid() })),
          putTxns: mergeInto(target.putTxns, plan.putTxns, optKey as (t: unknown) => string, (t) => ({ ...t, id: uid() })),
        };
        // Re-check the strategy label immediately, not just on next reload —
        // otherwise merging fresh data into a position that was stuck with a
        // stale/wrong label (e.g. one saved under an older version of the
        // inference logic) leaves it wrong until the user happens to reload
        // or hit Reclassify. Skip this entirely when the user explicitly
        // chose a strategy for this ticker in the import dialog — that
        // choice wins outright rather than being auto-corrected away.
        let updated: Position;
        if (manualStrategy) {
          const withStrategy: Position = { ...merged, strategy: plan.strategy, strategyOverride: true };
          updated = withStrategy.nameOverride ? withStrategy : { ...withStrategy, name: autoPositionName(withStrategy) };
        } else {
          updated = reclassifyPosition(merged).position;
        }
        if (idx >= 0) next[idx] = updated;
        else next.push(updated);
      }
      setPositions(next);
      return summary;
    },
    [positions]
  );

  const splitPosition = useCallback(
    (positionId: string, selection: SplitSelection, targetPositionId?: string): string | null => {
      const totalSelected =
        selection.stockTxnIds.length +
        selection.longTxnIds.length +
        selection.optionTxnIds.length +
        selection.putTxnIds.length;
      if (totalSelected === 0) return null;

      const idx = positions.findIndex((p) => p.id === positionId);
      if (idx === -1) return null;
      const source = positions[idx];

      const stockSet = new Set(selection.stockTxnIds);
      const longSet = new Set(selection.longTxnIds);
      const optionSet = new Set(selection.optionTxnIds);
      const putSet = new Set(selection.putTxnIds);

      const remainingSource: Position = {
        ...source,
        stockTxns: source.stockTxns.filter((t) => !stockSet.has(t.id)),
        longTxns: source.longTxns.filter((t) => !longSet.has(t.id)),
        optionTxns: source.optionTxns.filter((t) => !optionSet.has(t.id)),
        putTxns: source.putTxns.filter((t) => !putSet.has(t.id)),
      };
      const remainingHasTxns =
        remainingSource.stockTxns.length +
          remainingSource.longTxns.length +
          remainingSource.optionTxns.length +
          remainingSource.putTxns.length >
        0;
      const movedTxns = {
        stockTxns: source.stockTxns.filter((t) => stockSet.has(t.id)),
        longTxns: source.longTxns.filter((t) => longSet.has(t.id)),
        optionTxns: source.optionTxns.filter((t) => optionSet.has(t.id)),
        putTxns: source.putTxns.filter((t) => putSet.has(t.id)),
      };

      // The source position's own update/removal happens first and is the
      // same either way; only what happens with the moved transactions
      // (become a new position, or merge into an existing one) branches.
      const next = [...positions];
      if (remainingHasTxns) {
        next[idx] = reclassifyPosition(remainingSource).position;
      } else {
        next.splice(idx, 1);
      }

      if (targetPositionId) {
        // Re-find the target AFTER the splice/update above — its index may
        // have shifted if the source was removed and sat earlier in the array.
        const targetIdx = next.findIndex((p) => p.id === targetPositionId);
        if (targetIdx === -1) return null; // target vanished somehow — bail rather than silently drop the transactions
        const merged: Position = {
          ...next[targetIdx],
          stockTxns: [...next[targetIdx].stockTxns, ...movedTxns.stockTxns],
          longTxns: [...next[targetIdx].longTxns, ...movedTxns.longTxns],
          optionTxns: [...next[targetIdx].optionTxns, ...movedTxns.optionTxns],
          putTxns: [...next[targetIdx].putTxns, ...movedTxns.putTxns],
        };
        next[targetIdx] = reclassifyPosition(merged).position;
        setPositions(next);
        return targetPositionId;
      }

      const newId = uid();
      const newPosition: Position = {
        id: newId,
        ticker: source.ticker,
        strategy: source.strategy, // reclassified below from what actually moved
        account: source.account,
        notes: `Split from an existing ${source.ticker} position on ${todayStr()}.`,
        createdDate: todayStr(),
        ...movedTxns,
        currentPrice: null,
        currentLongValue: null,
        currentShortValue: null,
        currentPutValue: null,
      };
      next.push(reclassifyPosition(newPosition).position);
      setPositions(next);
      return newId;
    },
    [positions]
  );

  const reclassifyAll = useCallback((): ReclassifySummary => {
    const summary: ReclassifySummary = { changed: 0, unchanged: 0 };
    const next = positions.map((p) => {
      const result = reclassifyPosition(p);
      if (result.changed) summary.changed++;
      else summary.unchanged++;
      return result.position;
    });
    if (summary.changed > 0) setPositions(next);
    return summary;
  }, [positions]);

  const value = useMemo<PositionsContextValue>(
    () => ({
      positions,
      addPosition,
      deletePosition,
      deletePositions,
      addStockTxn,
      addLongTxn,
      addOptionTxn,
      deleteTxn,
      updateTxn,
      updatePricing,
      updateNotes,
      setStrategy,
      resetStrategyToAuto,
      setName,
      resetNameToAuto,
      setAllPositions,
      applyImport,
      reclassifyAll,
      splitPosition,
    }),
    [
      positions,
      addPosition,
      deletePosition,
      deletePositions,
      addStockTxn,
      addLongTxn,
      addOptionTxn,
      deleteTxn,
      updateTxn,
      updatePricing,
      updateNotes,
      setStrategy,
      resetStrategyToAuto,
      setName,
      resetNameToAuto,
      setAllPositions,
      applyImport,
      reclassifyAll,
      splitPosition,
    ]
  );

  return <PositionsContext.Provider value={value}>{children}</PositionsContext.Provider>;
}

export function usePositions(): PositionsContextValue {
  const ctx = useContext(PositionsContext);
  if (!ctx) throw new Error('usePositions must be used within a PositionsProvider');
  return ctx;
}
