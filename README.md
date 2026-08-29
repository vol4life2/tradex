# TradeX

React + TypeScript + Vite cost-basis / breakeven tracker for options income
strategies: covered call, diagonal (PMCC), wheel (cash-secured put), vertical
spread, and strangle. Data is stored in the browser's local storage, with
JSON export/import for backups and CSV import (Schwab or tastytrade) for
trade history.

This supersedes the plain-HTML version in `../covered-call-tracker/` (kept as
a zero-dependency fallback — note the two apps do **not** share data, since
they run on different browser origins; use Export/Import to move data between
them).

## Running it

```bash
npm run dev
```

Then open http://localhost:5174. (`dev.bat` does the same and also works by
double-clicking it in Explorer — it adds Node to PATH first.)

Production build (outputs static files to `dist/`):

```bash
npm run build
```

## Data model / what the numbers mean

This is a **trading break-even tracker**, not a tax-lot / IRS cost-basis tool.
The full formulas are documented at the top of `src/lib/calc.ts`. Short version:

- **Covered call**: effective cost basis = average stock cost minus net
  premium collected from every call sold against those shares (every leg of
  every roll included). That's your breakeven stock price.
- **Diagonal / PMCC**: same idea with a long-dated long call as the "stock"
  leg. Effective cost basis = long call cost minus net premium collected.
- **Wheel / CSP**: short-put ledger plus the covered-call machinery. A put
  assignment buys shares at the strike; those shares' breakeven then folds in
  ALL premium collected on the ticker (puts and calls). A call assignment
  sells the shares at the strike; once nothing is open, realized P&L is the
  position's total lifetime cash flow.
- **Spread** (vertical): a short + long leg of the *same* option kind (e.g. a
  305/315 put credit spread). No stock ledger — net premium is just the
  running credit/debit across both legs, including every roll.
- **Strangle**: a short put + a short call, no stock backing either leg —
  each side rolls or closes independently, and the position stays "open" (and
  keeps its strangle label) as long as it has ever had short activity on both
  sides, even while one leg is temporarily flat between rolls.
- **Realized P&L** on a fully-closed position = total cash in minus total
  cash out over the position's life. No lot-matching, always right as a
  bottom line.
- Every strategy branch also **defensively counts stray ledger data** — e.g. a
  position reclassified away from "wheel" that leaves a stray long-call leg
  behind still gets that leg's cash flow folded into realized P&L (with a
  `needsAttention` flag and banner), rather than silently dropping it. See
  `strayLedgerImpact` in `calc.ts`.
- **Unrealized P&L** uses prices you type into the Pricing panel — nothing
  is fetched automatically.
- Stock/long-call basis uses the **average cost method**, not FIFO tax lots.
- Every position carries an optional **account** tag (e.g. "Schwab",
  "tastytrade") set by the CSV importers. The same ticker at two brokers is
  two separate positions with two separate cost bases — they're never
  merged, matched, or netted against each other. Positions you create by
  hand have no account tag.

## Code layout

```
src/
  types.ts                  — all shared TypeScript types
  lib/
    calc.ts                 — pure calculation engine (no React/DOM; the money math)
    strategyInference.ts    — decides which strategy a ticker's transactions look
                               like, from the transactions alone (import + reclassify)
    storage.ts              — localStorage persistence + JSON export/import
    format.ts               — formatting/utility helpers
  context/
    PositionsContext.tsx    — app state: positions + all mutations, auto-persisted
    ToastContext.tsx        — transient notification popups
  components/
    TopBar.tsx              — header, export/import, new-position entry point
    Dashboard.tsx           — all-positions summary + table
    PositionDetail.tsx      — single position view
    Modal.tsx               — portal-based modal (see comment inside for why a portal)
    NewPositionModal.tsx
    panels/
      StockLotPanel.tsx     — covered-call stock leg table + entry form
      LongLegPanel.tsx      — diagonal long-call leg table + entry form
      OptionLedgerPanel.tsx — call OR put ledger (STO/BTC/BTO/STC/Expired/Assigned),
                               parameterized by `leg` so the wheel view uses it twice
      PricingPanel.tsx      — manual mark prices for unrealized P&L
      NotesPanel.tsx
```

`calc.ts` deliberately has zero React/DOM dependencies so the money math can
be audited or unit-tested in isolation. `OptionTxnType` covers both directions
of a spread: `STO`/`BTC` open and close a **short** contract; `BTO`/`STC` open
and close a **long** contract in the *same* ledger — used for the protective
leg of a credit spread (e.g. the long 305P in a 305/315 put spread), so net
premium reflects the spread's true net credit rather than just the short leg.

## CSV import

**Import CSV** in the top bar accepts either broker's export and **auto-detects
the format** — no need to say which one. Both produce the same preview (ticker,
inferred strategy — overridable — transaction count, date range, merge target)
before anything is saved.

**Schwab** — a **transaction-history** export (Schwab.com → Accounts → History
→ Export). Trade rows (Buy, Sell, Sell/Buy to Open/Close, Assigned, Expired)
become ledger entries directly.
- Non-trade rows (dividends, transfers, interest, journals) are ignored.
- Exercise rows are skipped and listed with reasons (they convert an option
  into a stock trade Schwab doesn't itemize the same way).
- "Expired"/"Assigned" rows don't say short-vs-long; the importer uses the
  row's own quantity sign where available, falling back to replaying history
  chronologically and tracking open interest per contract. Contracts whose
  opening trade predates the export window are assumed short and flagged in
  the transaction note.
- Schwab reports an assignment as **two** rows — the `Assigned` option row
  plus an explicit stock Buy/Sell at the strike. The importer detects and
  folds the paired stock row in, since the calc engine already synthesizes
  the share movement from the option row alone.
- **Note:** a 1099-B download is NOT a transaction history (it has closed tax
  lots only, no running position) and will not import.

**tastytrade** — the **gain/loss tax worksheet** CSV (Monitor → Tax →
Gain/Loss, or the account statements page). This is a *closed-lots* file, not
a fills history — but each row carries both ends of a round trip (open date +
cost, close date + proceeds, long/short flag, close event), which is enough
to reconstruct the pair of ledger transactions faithfully. Rows with no close
event are still-open lots and import as just their opening transaction.
- Only equities and single-leg option round trips are read directly; this
  covers verticals/spreads too, since each leg is its own row (the long leg
  imports as `BTO`/`STC` in the same put or call ledger as its short leg).
- **Caveat:** positions closed entirely *outside* the worksheet's tax year
  won't appear (the file doesn't carry them), and only 1256-eligible /
  reportable lots are included — this file is a tax export, not a full
  activity log.

Re-importing either format is always safe: exact-duplicate transactions are
skipped, and re-importing over the same ticker+broker merges rather than
duplicates the position.

The parsers live in `src/lib/schwabCsv.ts` and `src/lib/tastytradeCsv.ts`
(pure modules, no React/DOM); `finalizePlans`/`emptyPlan` in `schwabCsv.ts`
are shared by both so strategy inference and warnings stay consistent.

## Strategy inference & reclassification

`src/lib/strategyInference.ts` decides which of the five strategies a
ticker's transactions actually look like — from the transactions alone, not
from any label the importer or user set previously. It runs in two places:

1. **At CSV import**, to pre-fill the strategy in the confirmation preview
   (still overridable per ticker before you confirm).
2. **On every load** (`storage.ts`'s `normalizePosition`) and via the
   **Reclassify Strategies** button in the top bar, to self-heal positions
   whose label no longer fits their transactions — e.g. anything imported
   under an earlier, cruder version of this logic that called every position
   with a put leg "Wheel" even when it was really a put spread or a
   strangle. Positions with zero transactions are left alone, since there's
   nothing to infer and it would clobber a deliberate manual choice on a
   not-yet-populated position.

`promoteSameExpirationCallSpreads` handles one subtlety: some importers
route long calls into the diagonal's `longTxns` ledger by default. If one of
those legs turns out to share an expiration with a short call, it's really
the long leg of a same-week vertical, not a calendar — that *specific leg*
(not the whole ticker) gets moved into the call ledger so it reads as a
spread. Real diagonals (a LEAPS-dated long call against short-dated short
calls, different expirations) are untouched.

## Splitting a position (one ticker, multiple campaigns)

Real trading history on a ticker isn't always one continuous strategy — e.g.
SLV ran as a strangle for a few months, went fully flat, then reopened later
as a diagonal. The app still models one strategy label per position, so
**Split Position** (in the position detail header) lets you divide that
history yourself: it lists every transaction across all four ledgers in one
chronological table with checkboxes, plus a "↑ here" shortcut per row that
selects that row and everything above it (the common case — an old episode
occupies the top of the list, chronologically). Confirming moves the checked
transactions into a brand-new position and re-infers the strategy for *both*
the new position and whatever's left behind, from their own transactions —
so an old, fully-closed strangle can split cleanly away from a currently-open
diagonal on the same ticker. `PositionsContext.splitPosition` does the
underlying move-and-reclassify; nothing is created or destroyed financially,
just repartitioned (verified: the sum of realized P&L across the two halves
always equals what the single blended position showed before the split).

## Bulk operations

- **Dashboard**: a checkbox column plus a header "select all" toggle; once
  anything is checked, a bar appears with **Delete Selected** (single
  confirm dialog, single state update via `deletePositions`).
- **CSV import preview**: a checkbox per ticker (default all checked) lets
  you exclude tickers you don't want to bring in at all — unchecked rows are
  simply left out of `applyImport`'s plan list, so nothing about them is
  written anywhere.
- **CSV import target**: when a ticker already has one or more existing
  positions (same ticker + account), the Target column becomes a dropdown —
  merge into any specific one of them, or force **Create new position**
  regardless of the match (the `ImportTarget` type in
  `PositionsContext.tsx`: `'auto'` keeps the historical best-match-or-create
  behavior, `'new'` always creates fresh, `'merge'` pins an exact position
  id). This is what keeps a re-import from re-blending a ticker you've
  already split apart.

## Backup / transfer

**Export** downloads a timestamped JSON snapshot of all positions. **Import**
reads one back, with a choice to merge or replace. The export format is
identical to the vanilla version's, so backups move freely between the two apps.
