import { useState } from 'react';
import type { FormEvent } from 'react';
import { usePositions } from '../../context/PositionsContext';
import { useToast } from '../../context/ToastContext';
import type { Position } from '../../types';

export default function NotesPanel({ position }: { position: Position }) {
  const { updateNotes } = usePositions();
  const { toast } = useToast();
  const [notes, setNotes] = useState(position.notes || '');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateNotes(position.id, notes.trim());
    toast('Notes saved');
  }

  return (
    <div className="panel">
      <h3>Notes</h3>
      <form onSubmit={handleSubmit}>
        <textarea rows={2} placeholder="Notes..." value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="modal-actions">
          <button type="submit" className="btn btn-secondary">
            Save Notes
          </button>
        </div>
      </form>
    </div>
  );
}
