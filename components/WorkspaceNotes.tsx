import React, { useState } from 'react';

interface WorkspaceNotesProps {
  notes: string[];
  setNotes: React.Dispatch<React.SetStateAction<string[]>>;
}

const WorkspaceNotes: React.FC<WorkspaceNotesProps> = ({ notes, setNotes }) => {
  const [draft, setDraft] = useState('');

  return (
    <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
      <div className="text-xs uppercase tracking-[0.2em] text-teal-700 font-bold mb-4">Workspace Notes</div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Capture analyst notes, caveats, or client commentary..."
        className="w-full rounded-xl border border-slate-200 px-4 py-3 min-h-28 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition"
      />
      <div className="mt-3 flex justify-end">
        <button
          onClick={() => {
            if (!draft.trim()) return;
            setNotes((current) => [draft, ...current]);
            setDraft('');
          }}
          className="rounded-full bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 transition"
        >
          Add Note
        </button>
      </div>

      {notes.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-slate-200 p-10 text-center">
          <svg className="w-10 h-10 text-slate-300 mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          <p className="text-slate-500 font-medium text-sm">No notes yet</p>
          <p className="text-slate-400 text-xs mt-1">Use this space to capture observations, caveats, or questions as you review evidence.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {notes.map((note, index) => (
            <div key={index} className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-sm text-slate-700 hover:border-slate-300 transition">
              {note}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export default WorkspaceNotes;
