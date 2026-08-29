import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { usePositions } from '../../context/PositionsContext';
import { useToast } from '../../context/ToastContext';
import { num } from '../../lib/format';
import type { Position } from '../../types';

/** Same majority-rule heuristic calc.ts uses to pick which ledger a vertical lives in. */
function verticalOptionKind(position: Position): 'C' | 'P' {
  return position.putTxns.length > position.optionTxns.length ? 'P' : 'C';
}

export default function PricingPanel({ position }: { position: Position }) {
  const { updatePricing } = usePositions();
  const { toast } = useToast();
  const [currentPrice, setCurrentPrice] = useState(position.currentPrice?.toString() ?? '');
  const [currentLongValue, setCurrentLongValue] = useState(position.currentLongValue?.toString() ?? '');
  const [currentShortValue, setCurrentShortValue] = useState(position.currentShortValue?.toString() ?? '');
  const [currentPutValue, setCurrentPutValue] = useState(position.currentPutValue?.toString() ?? '');

  const isPutDiagonal = position.strategy === 'put_diagonal';
  const isDiagonal = position.strategy === 'diagonal' || isPutDiagonal;
  const isCoveredCall = position.strategy === 'covered_call' || position.strategy === 'stock';
  const isVertical = position.strategy === 'credit_vertical' || position.strategy === 'debit_vertical';
  const isStrangle = position.strategy === 'strangle';
  const verticalKind = isVertical ? verticalOptionKind(position) : null;

  // Keep local fields in sync if the position changes underneath us (e.g. import).
  useEffect(() => {
    setCurrentPrice(position.currentPrice?.toString() ?? '');
    setCurrentLongValue(position.currentLongValue?.toString() ?? '');
    setCurrentShortValue(position.currentShortValue?.toString() ?? '');
    setCurrentPutValue(position.currentPutValue?.toString() ?? '');
  }, [
    position.id,
    position.currentPrice,
    position.currentLongValue,
    position.currentShortValue,
    position.currentPutValue,
  ]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updatePricing(position.id, {
      ...(isDiagonal || isVertical
        ? { currentLongValue: currentLongValue ? num(currentLongValue) : null }
        : {}),
      ...(!isVertical && !isDiagonal && !isStrangle ? { currentPrice: currentPrice ? num(currentPrice) : null } : {}),
      currentShortValue: currentShortValue ? num(currentShortValue) : null,
      ...(isCoveredCall || isStrangle ? { currentPutValue: currentPutValue ? num(currentPutValue) : null } : {}),
    });
    toast('Pricing updated');
  }

  return (
    <div className="panel">
      <h3>Pricing (for unrealized P&amp;L)</h3>
      <form onSubmit={handleSubmit}>
        <div className="form-row">
          {isDiagonal && (
            <label className="field">
              <span>Current Long {isPutDiagonal ? 'Put' : 'Call'} Value/Share</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={currentLongValue}
                onChange={(e) => setCurrentLongValue(e.target.value)}
              />
            </label>
          )}
          {isVertical && (
            <label className="field">
              <span>Current Long {verticalKind === 'P' ? 'Put' : 'Call'} Leg Value/Share</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={currentLongValue}
                onChange={(e) => setCurrentLongValue(e.target.value)}
              />
            </label>
          )}
          {!isDiagonal && !isVertical && !isStrangle && (
            <label className="field">
              <span>Current Stock Price</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={currentPrice}
                onChange={(e) => setCurrentPrice(e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span>
              Current Short{' '}
              {isVertical ? (verticalKind === 'P' ? 'Put' : 'Call') : isPutDiagonal ? 'Put' : 'Call'} Value/Share
              {isDiagonal ? ' (optional)' : ''}
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={currentShortValue}
              onChange={(e) => setCurrentShortValue(e.target.value)}
            />
          </label>
          {(isCoveredCall || isStrangle) && (
            <label className="field">
              <span>Current Short Put Value/Share{isCoveredCall ? ' (optional)' : ''}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={currentPutValue}
                onChange={(e) => setCurrentPutValue(e.target.value)}
              />
            </label>
          )}
        </div>
        <p className="hint">Used only to estimate unrealized P&amp;L while the position is open. Leave blank to skip.</p>
        <div className="modal-actions">
          <button type="submit" className="btn btn-secondary">
            Update Pricing
          </button>
        </div>
      </form>
    </div>
  );
}
