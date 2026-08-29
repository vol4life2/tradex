import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface ToastItem {
  id: number;
  message: string;
  show: boolean;
}

interface ToastContextValue {
  toast: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const toast = useCallback((message: string) => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, message, show: false }]);
    // flip to visible on next tick so the CSS transition runs
    requestAnimationFrame(() => {
      setItems((prev) => prev.map((t) => (t.id === id ? { ...t, show: true } : t)));
    });
    setTimeout(() => {
      setItems((prev) => prev.map((t) => (t.id === id ? { ...t, show: false } : t)));
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 250);
    }, 2200);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {items.map((t) => (
        <div key={t.id} className={`toast${t.show ? ' toast-show' : ''}`}>
          {t.message}
        </div>
      ))}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
