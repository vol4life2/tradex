import { useEffect, useState } from 'react';
import { usePositions } from '../context/PositionsContext';
import { useConfirm } from '../context/ConfirmContext';
import { computePositionMetrics, computeLockedInProfit } from '../lib/calc';
import { fmtMoney, fmtNum, plClass } from '../lib/format';
import StockLotPanel from './panels/StockLotPanel';
import LongLegPanel from './panels/LongLegPanel';
import OptionLedgerPanel from './panels/OptionLedgerPanel';
import PricingPanel from './panels/PricingPanel';
import NotesPanel from './panels/NotesPanel';
import CostBasisHistoryPanel from './panels/CostBasisHistoryPanel';
import SplitPositionModal from './SplitPositionModal';
import { STRATEGY_LABEL, strangleKindLabel } from '../lib/strategyLabel';
import type { CoveredCallMetrics, DiagonalMetrics, Position, PositionMetrics, SpreadMetrics, Strategy, StrangleMetrics } from '../types';

const strayLegHint =
  'It counts in the P&L math but has no panel here — check if this ticker should really be split (Split Position) or reclassified (Reclassify Strategies in the top bar), if the two don\'t actually belong together.';

/** needsAttention is a single boolean covering a few different real causes
 *  (an actual assignment vs. stray data left over from an unrelated,
 *  possibly non-overlapping campaign on the same ticker) — check the
 *  position's real transactions rather than presupposing which one it was,
 *  so this doesn't tell the user something was assigned when it wasn't. */
function needsAttentionMessage(m: PositionMetrics, position: Position): string {
  switch (m.strategy) {
    case 'diagonal':
    case 'put_diagonal': {
      const shortLedger = m.strategy === 'put_diagonal' ? position.putTxns : position.optionTxns;
      if (shortLedger.some((t) => t.type === 'ASSIGNED')) {
        return 'A short option on this diagonal was assigned. Remember to record how the long leg was resolved (exercised, sold, or closed) below.';
      }
      return `This position also has trades outside its long/short ledgers shown below — most likely a leftover leg from a different, unrelated campaign on this ticker. ${strayLegHint}`;
    }
    case 'credit_vertical':
    case 'debit_vertical': {
      const shortLedger = m.optionKind === 'P' ? position.putTxns : position.optionTxns;
      if (shortLedger.some((t) => t.type === 'ASSIGNED')) {
        return 'A leg of this vertical was assigned. There is no stock ledger here to hold assigned shares — record what happened to them separately.';
      }
      return `This position also has trades outside the vertical ledger shown below. ${strayLegHint}`;
    }
    case 'strangle': {
      if (position.putTxns.some((t) => t.type === 'ASSIGNED') || position.optionTxns.some((t) => t.type === 'ASSIGNED')) {
        return 'A leg of this strangle was assigned. There is no stock ledger here to hold assigned shares — record what happened to them separately.';
      }
      return `This position also has trades outside the put/call ledgers shown below — most likely a leftover leg from a different, unrelated campaign on this ticker (e.g. an old closed position that predates this one). ${strayLegHint}`;
    }
    case 'covered_call':
    case 'stock':
      return `This position also has long-option trades outside its stock/put/call ledgers. ${strayLegHint}`;
    default:
      return '';
  }
}

export default function PositionDetail({
  positionId,
  onBack,
  onNavigate,
}: {
  positionId: string;
  onBack: () => void;
  onNavigate: (id: string) => void;
}) {
  const { positions, deletePosition, setStrategy, resetStrategyToAuto, setName, resetNameToAuto } = usePositions();
  const confirm = useConfirm(); // must run before the early return below (rules of hooks)
  const [showSplit, setShowSplit] = useState(false); // same: hooks before the early return
  const position = positions.find((p) => p.id === positionId);
  // Local draft so typing doesn't commit (and re-save to localStorage) on
  // every keystroke; re-synced below whenever the position identity or its
  // name changes underneath us (e.g. navigating to a different position —
  // this component isn't remounted when positionId changes).
  const [nameDraft, setNameDraft] = useState(position?.name ?? '');
  useEffect(() => {
    setNameDraft(position?.name ?? '');
  }, [position?.id, position?.name]);

  if (!position) {
    onBack();
    return null;
  }

  const m = computePositionMetrics(position);

  function commitName() {
    if (!position) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== position.name) {
      setName(position.id, trimmed);
    } else {
      setNameDraft(position.name ?? ''); // empty/unchanged — revert the draft rather than save a blank name
    }
  }

  return (
    <>
      <div className="detail-header">
        <button className="btn btn-ghost" onClick={onBack}>
          &larr; All Positions
        </button>
        <div className="detail-title-row">
          <h2>
            {position.ticker}
            {position.account && <span className="account-tag">{position.account}</span>}
          </h2>
          <select
            className="strategy-select"
            value={position.strategy}
            title="Change this position's strategy. Manually picking one stops auto-detection from correcting it on later imports/reloads."
            onChange={(e) => setStrategy(position.id, e.target.value as Strategy)}
          >
            {Object.entries(STRATEGY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {value === 'strangle' ? strangleKindLabel(position) : label}
              </option>
            ))}
          </select>
          {position.strategyOverride ? (
            <button
              className="btn btn-ghost btn-icon"
              title="Discard the manual choice and re-detect the strategy from this position's actual transactions"
              onClick={() => resetStrategyToAuto(position.id)}
            >
              ↺ Auto-detect
            </button>
          ) : (
            <span className="chip chip-muted" title="Automatically detected from this position's transaction shape">
              auto
            </span>
          )}
          {m.fullyClosed ? <span className="chip chip-closed">CLOSED</span> : <span className="chip chip-open">OPEN</span>}
          <button
            className="btn btn-ghost"
            title="Move some of this position's transactions into a new, separate position — e.g. an old closed campaign vs. a new one"
            onClick={() => setShowSplit(true)}
          >
            ✂ Split Position
          </button>
          <button
            className="btn btn-icon btn-danger"
            title="Delete position"
            onClick={async () => {
              if (await confirm(`All of ${position.ticker}'s transactions will be permanently deleted.`, { title: `Delete ${position.ticker}?` })) {
                deletePosition(position.id);
                onBack();
              }
            }}
          >
            🗑 Delete Position
          </button>
        </div>
        <div className="detail-name-row">
          <input
            type="text"
            className="position-name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            title="This position's display name — shown in the dashboard list and the CSV-import merge-target picker, so it's what tells two positions on the same ticker apart. Editing it stops auto-naming from updating it on later imports/reclassifies."
          />
          {position.nameOverride ? (
            <button
              className="btn btn-ghost btn-icon"
              title="Discard the manual name and regenerate it from the ticker, strategy, and start date"
              onClick={() => resetNameToAuto(position.id)}
            >
              ↺ Auto-name
            </button>
          ) : (
            <span
              className="chip chip-muted"
              title="Automatically generated from the ticker, strategy, and earliest transaction date"
            >
              auto
            </span>
          )}
        </div>
      </div>

      {showSplit && (
        <SplitPositionModal
          position={position}
          onClose={() => setShowSplit(false)}
          onSplit={(newId) => {
            setShowSplit(false);
            onNavigate(newId);
          }}
        />
      )}

      {m.needsAttention && <div className="banner banner-warn">{needsAttentionMessage(m, position)}</div>}

      {(m.strategy === 'covered_call' || m.strategy === 'stock') && <CCSummary m={m} position={position} />}
      {(m.strategy === 'diagonal' || m.strategy === 'put_diagonal') && <DiagSummary m={m} position={position} />}
      {(m.strategy === 'credit_vertical' || m.strategy === 'debit_vertical') && <SpreadSummary m={m} />}
      {m.strategy === 'strangle' && <StrangleSummary m={m} />}

      {(m.strategy === 'covered_call' ||
        m.strategy === 'stock' ||
        m.strategy === 'diagonal' ||
        m.strategy === 'put_diagonal') && <CostBasisHistoryPanel position={position} />}

      {(m.strategy === 'covered_call' || m.strategy === 'stock') && (
        <>
          <div className="detail-grid">
            <OptionLedgerPanel
              position={position}
              leg="put"
              openShortContracts={m.openShortPuts}
              lastExpiration={null}
            />
            <StockLotPanel position={position} />
          </div>
          <OptionLedgerPanel
            position={position}
            leg="call"
            openShortContracts={m.openShortContracts}
            lastExpiration={null}
          />
        </>
      )}

      {m.strategy === 'strangle' && (
        <div className="detail-grid">
          <OptionLedgerPanel
            position={position}
            leg="put"
            title="Put Leg"
            openShortContracts={m.openShortPuts}
            lastExpiration={null}
          />
          <OptionLedgerPanel
            position={position}
            leg="call"
            title="Call Leg"
            openShortContracts={m.openShortCalls}
            lastExpiration={null}
          />
        </div>
      )}

      {(m.strategy === 'credit_vertical' || m.strategy === 'debit_vertical') && (
        <OptionLedgerPanel
          position={position}
          leg={m.optionKind === 'P' ? 'put' : 'call'}
          title={`${m.optionKind === 'P' ? 'Put' : 'Call'} Ledger (short + long leg)`}
          openShortContracts={m.openShortContracts}
          openLongContracts={m.openLongContracts}
          lastExpiration={m.lastExpiration}
        />
      )}

      {(m.strategy === 'diagonal' || m.strategy === 'put_diagonal') && (
        <div className="detail-grid">
          <LongLegPanel position={position} kind={m.strategy === 'put_diagonal' ? 'P' : 'C'} />
          <OptionLedgerPanel
            position={position}
            leg={m.strategy === 'put_diagonal' ? 'put' : 'call'}
            openShortContracts={m.openShortContracts}
            lastExpiration={m.lastExpiration}
          />
        </div>
      )}

      <PricingPanel position={position} />
      <NotesPanel position={position} />
    </>
  );
}

function CCSummary({ m, position }: { m: CoveredCallMetrics; position: Position }) {
  const pl = m.fullyClosed ? m.realizedPL : m.unrealizedPL;
  const lockedIn = m.fullyClosed ? null : computeLockedInProfit(position);
  return (
    <div className="summary-grid summary-grid-detail">
      <div className="summary-card">
        <div className="summary-label">Shares Held</div>
        <div className="summary-value">{fmtNum(m.sharesHeld)}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">Avg Stock Cost / Share</div>
        <div className="summary-value">{m.sharesHeld > 0 ? fmtMoney(m.avgStockCost) : '—'}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">Net Premium (Puts + Calls)</div>
        <div className={`summary-value ${plClass(m.netPremiumCollected)}`} title={`Puts: ${fmtMoney(m.netPutPremium)} · Calls: ${fmtMoney(m.netCallPremium)}`}>
          {fmtMoney(m.netPremiumCollected)}
        </div>
      </div>
      <div className="summary-card highlight">
        <div className="summary-label">Breakeven Price</div>
        <div className="summary-value">{m.breakevenPrice == null ? '—' : fmtMoney(m.breakevenPrice)}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">Open Puts / Calls</div>
        <div className="summary-value">
          {fmtNum(m.openShortPuts)} / {fmtNum(m.openShortContracts)}
        </div>
      </div>
      <div className="summary-card">
        <div className="summary-label">{m.fullyClosed ? 'Realized P&L' : 'Unrealized P&L'}</div>
        <div className={`summary-value ${plClass(pl)}`}>{fmtMoney(pl)}</div>
      </div>
      {lockedIn != null && (
        <div className="summary-card">
          <div className="summary-label" title="Profit already booked from closed rolls, even though the position itself is still open — doesn't need a current price to show.">
            Locked-In Profit
          </div>
          <div className={`summary-value ${plClass(lockedIn)}`}>{fmtMoney(lockedIn)}</div>
        </div>
      )}
    </div>
  );
}

function DiagSummary({ m, position }: { m: DiagonalMetrics; position: Position }) {
  const pl = m.fullyClosed ? m.realizedPL : m.unrealizedPL;
  const lockedIn = m.fullyClosed ? null : computeLockedInProfit(position);
  return (
    <div className="summary-grid summary-grid-detail">
      <div className="summary-card">
        <div className="summary-label">Open Long Contracts</div>
        <div className="summary-value">{fmtNum(m.openLongContracts)}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">Avg Long {m.strategy === 'put_diagonal' ? 'Put' : 'Call'} Cost / Share</div>
        <div className="summary-value">{fmtMoney(m.avgLongCost)}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">Net Premium Collected</div>
        <div className={`summary-value ${plClass(m.netPremiumCollected)}`}>{fmtMoney(m.netPremiumCollected)}</div>
      </div>
      <div className="summary-card highlight">
        <div className="summary-label">Eff. Cost Basis / Contract</div>
        <div className="summary-value">
          {m.effectiveCostBasisPerContract == null ? '—' : fmtMoney(m.effectiveCostBasisPerContract)}
        </div>
      </div>
      <div className="summary-card">
        <div className="summary-label">Open Short Contracts</div>
        <div className="summary-value">{fmtNum(m.openShortContracts)}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">{m.fullyClosed ? 'Realized P&L' : 'Unrealized P&L'}</div>
        <div className={`summary-value ${plClass(pl)}`}>{fmtMoney(pl)}</div>
      </div>
      {lockedIn != null && (
        <div className="summary-card">
          <div className="summary-label" title="Profit already booked from closed short-leg rolls, even though the long leg is still open — doesn't need a current price to show.">
            Locked-In Profit
          </div>
          <div className={`summary-value ${plClass(lockedIn)}`}>{fmtMoney(lockedIn)}</div>
        </div>
      )}
    </div>
  );
}

function SpreadSummary({ m }: { m: SpreadMetrics }) {
  const pl = m.fullyClosed ? m.realizedPL : m.unrealizedPL;
  return (
    <div className="summary-grid summary-grid-detail">
      <div className="summary-card">
        <div className="summary-label">Option Kind</div>
        <div className="summary-value">{m.optionKind === 'P' ? 'Puts' : 'Calls'}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">Open Short / Long</div>
        <div className="summary-value">
          {fmtNum(m.openShortContracts)} / {fmtNum(m.openLongContracts)}
        </div>
      </div>
      <div className="summary-card highlight">
        <div className="summary-label">Net Credit Collected</div>
        <div className={`summary-value ${plClass(m.netPremiumCollected)}`}>{fmtMoney(m.netPremiumCollected)}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">{m.fullyClosed ? 'Realized P&L' : 'Unrealized P&L'}</div>
        <div className={`summary-value ${plClass(pl)}`}>{fmtMoney(pl)}</div>
      </div>
    </div>
  );
}

function StrangleSummary({ m }: { m: StrangleMetrics }) {
  const pl = m.fullyClosed ? m.realizedPL : m.unrealizedPL;
  return (
    <div className="summary-grid summary-grid-detail">
      <div className="summary-card">
        <div className="summary-label">Open Short Puts</div>
        <div className="summary-value">{fmtNum(m.openShortPuts)}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">Open Short Calls</div>
        <div className="summary-value">{fmtNum(m.openShortCalls)}</div>
      </div>
      <div className="summary-card highlight">
        <div className="summary-label">Net Premium (Puts + Calls)</div>
        <div
          className={`summary-value ${plClass(m.netPremiumCollected)}`}
          title={`Puts: ${fmtMoney(m.netPutPremium)} · Calls: ${fmtMoney(m.netCallPremium)}`}
        >
          {fmtMoney(m.netPremiumCollected)}
        </div>
      </div>
      <div className="summary-card">
        <div className="summary-label">{m.fullyClosed ? 'Realized P&L' : 'Unrealized P&L'}</div>
        <div className={`summary-value ${plClass(pl)}`}>{fmtMoney(pl)}</div>
      </div>
    </div>
  );
}
