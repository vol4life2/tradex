import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Modal from '../components/Modal';

interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive (red). Defaults to true — nearly
   *  every call site in this app is a delete. */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  message: string;
}

type ConfirmFn = (message: string, options?: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Promise-based replacement for `window.confirm`. Native confirm() dialogs
 * are unreliable in practice — some browsers/extensions/enterprise policies
 * suppress them outright, and a user can tick "prevent this page from
 * creating additional dialogs" after repeated use, after which every future
 * confirm() call resolves false with no visible dialog at all, silently
 * turning every "Delete" button into a no-op. Rendering our own modal avoids
 * that whole class of failure and looks like the rest of the app besides.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const resolverRef = useRef<((result: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((message, options) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setPending({ message, ...options });
    });
  }, []);

  function settle(result: boolean) {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setPending(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <Modal onClose={() => settle(false)}>
          <h2>{pending.title ?? 'Are you sure?'}</h2>
          <p className="confirm-message">{pending.message}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => settle(false)}>
              {pending.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              className={`btn ${pending.danger === false ? 'btn-primary' : 'btn-danger'}`}
              autoFocus
              onClick={() => settle(true)}
            >
              {pending.confirmLabel ?? 'Delete'}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
}
