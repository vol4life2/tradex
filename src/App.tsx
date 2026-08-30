import { useState } from 'react';
import TopBar from './components/TopBar';
import Dashboard from './components/Dashboard';
import PositionDetail from './components/PositionDetail';
import { ALL_ACCOUNTS, type StatusFilter } from './lib/filters';

type View = { type: 'dashboard' } | { type: 'detail'; id: string };

export default function App() {
  const [view, setView] = useState<View>({ type: 'dashboard' });
  // Owned here (not in Dashboard) since the filter selects render in the
  // header, which persists across both views.
  const [accountFilter, setAccountFilter] = useState<string>(ALL_ACCOUNTS);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  return (
    <>
      <TopBar
        accountFilter={accountFilter}
        setAccountFilter={setAccountFilter}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        showFilters={view.type === 'dashboard'}
      />
      <main className="app">
        {view.type === 'detail' ? (
          <PositionDetail
            positionId={view.id}
            onBack={() => setView({ type: 'dashboard' })}
            onNavigate={(id) => setView({ type: 'detail', id })}
          />
        ) : (
          <Dashboard
            onOpenPosition={(id) => setView({ type: 'detail', id })}
            accountFilter={accountFilter}
            statusFilter={statusFilter}
          />
        )}
      </main>
    </>
  );
}
