import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

// Rendered via a portal into #modal-root (a sibling of #root, at the very
// end of <body>) rather than in place. This matters: `position: fixed`
// establishes its containing block relative to the nearest ancestor with a
// transform/filter/backdrop-filter, not necessarily the viewport. The
// topbar uses backdrop-filter for its frosted-glass effect, so a modal
// rendered inline inside it would be boxed into the topbar's own (short)
// height instead of centering in the viewport.
export default function Modal({
  children,
  onClose,
  wide = false,
}: {
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return null;

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal-dialog${wide ? ' modal-dialog-wide' : ''}`} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>,
    modalRoot
  );
}
