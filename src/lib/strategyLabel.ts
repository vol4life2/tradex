/*
 * strategyLabel.ts — human-readable strategy names. Pure, no React/DOM —
 * needed by storage.ts (auto-naming positions) as well as by UI components,
 * so it lives here rather than inside a component file.
 */
import type { Position } from '../types';

/** Generic name for a strategy VALUE, with no position data behind it — used
 *  for dropdowns/pickers (New Position, CSV import preview). For an actual
 *  position, use positionStrategyLabel below instead: 'strangle' there gets
 *  a data-dependent name ("Short Put" for a lone naked put, etc.) since
 *  there's no separate strategy value for that — it's just the one-legged
 *  case of the same naked-short-options bucket. */
export const STRATEGY_LABEL: Record<string, string> = {
  stock: 'Stock',
  covered_call: 'Covered Call',
  diagonal: 'Call Diagonal',
  put_diagonal: 'Put Diagonal',
  credit_vertical: 'Credit Vertical',
  debit_vertical: 'Debit Vertical',
  strangle: 'Strangle',
};

/** 'strangle' covers three real shapes depending on which leg(s) actually
 *  have activity: a lone short put (no separate "wheel"/CSP strategy — it's
 *  just this until assignment flips it to covered_call), a lone naked call,
 *  or a true two-sided strangle. Everything else uses the generic name. */
export function strangleKindLabel(position: Pick<Position, 'putTxns' | 'optionTxns'>): string {
  const hasPuts = position.putTxns.length > 0;
  const hasCalls = position.optionTxns.length > 0;
  if (hasPuts && !hasCalls) return 'Short Put';
  if (hasCalls && !hasPuts) return 'Naked Call';
  return 'Strangle';
}

export function positionStrategyLabel(position: Position): string {
  if (position.strategy === 'strangle') return strangleKindLabel(position);
  return STRATEGY_LABEL[position.strategy] ?? position.strategy;
}
