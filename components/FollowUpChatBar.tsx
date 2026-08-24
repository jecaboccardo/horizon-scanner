import React, { useEffect, useState } from 'react';

interface FollowUpChatBarProps {
  /** Seed text (e.g. a clicked "suggested follow-up"). Applied only when it
   *  changes to a non-empty value, so it never clobbers what the user is typing. */
  prefill: string;
  isLoading: boolean;
  onSubmit: (text: string) => void;
}

/**
 * Bottom-docked follow-up input, extracted from App so its text lives in LOCAL
 * state. Previously the input bound App's shared `query` state, so every
 * keystroke re-rendered App and its sibling — the ~3,900-line, un-memoized
 * BriefView — which was the main "typing feels laggy" cause on mobile. Local
 * state means a keystroke re-renders only this small bar. Memoized so unrelated
 * App re-renders (snapshot polls, chat streaming) don't re-render it either
 * (onSubmit is passed stable from App).
 */
const FollowUpChatBar: React.FC<FollowUpChatBarProps> = ({ prefill, isLoading, onSubmit }) => {
  const [text, setText] = useState('');
  useEffect(() => { if (prefill) setText(prefill); }, [prefill]);

  const submit = () => {
    const t = text.trim();
    if (!t || isLoading) return;
    onSubmit(t);
    setText('');
  };

  return (
    <div className="bg-white rounded-xl border border-slate-300 shadow-lg flex items-center gap-2 px-4 py-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Ask a follow-up about this brief..."
        className="flex-1 bg-transparent border-none outline-none text-sm py-2 placeholder:text-slate-400"
      />
      <button
        onClick={submit}
        disabled={isLoading || !text.trim()}
        aria-label="Send"
        className="w-9 h-9 rounded-full bg-teal-600 text-white flex items-center justify-center hover:bg-teal-700 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
      >
        {isLoading ? (
          <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        )}
      </button>
    </div>
  );
};

export default React.memo(FollowUpChatBar);
