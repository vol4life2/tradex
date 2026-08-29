import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { PositionsProvider } from './context/PositionsContext';
import { ToastProvider } from './context/ToastContext';
import { ConfirmProvider } from './context/ConfirmContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <PositionsProvider>
          <App />
        </PositionsProvider>
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>
);
