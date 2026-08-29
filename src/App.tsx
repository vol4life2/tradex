import { useState } from 'react';
import TopBar from './components/TopBar';
import Dashboard from './components/Dashboard';
import PositionDetail from './components/PositionDetail';

type View = { type: 'dashboard' } | { type: 'detail'; id: string };

export default function App() {
  const [view, setView] = useState<View>({ type: 'dashboard' });

  return (
    <>
      <TopBar onPositionCreated={(id) => setView({ type: 'detail', id })} />
      <main className="app">
        {view.type === 'detail' ? (
          <PositionDetail
            positionId={view.id}
            onBack={() => setView({ type: 'dashboard' })}
            onNavigate={(id) => setView({ type: 'detail', id })}
          />
        ) : (
          <Dashboard onOpenPosition={(id) => setView({ type: 'detail', id })} />
        )}
      </main>
    </>
  );
}
