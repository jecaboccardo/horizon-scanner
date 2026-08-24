import React, { useEffect, useMemo, useRef } from 'react';
import { ChatMessage, EvidenceRow } from '../types';

interface ChatPanelProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingText: string;
  error: string | null;
  onDeleteMessage: (messageId: string) => void;
  onRetryMessage?: (messageId: string) => void;
  // Evidence rows of the brief this chat belongs to. Used to render [workId]
  // citation tokens as author-year chips instead of raw ids (most workIds are
  // bare DOIs, which read as garbage in the answer text).
  evidenceRows?: EvidenceRow[];
}

/**
 * Lightweight markdown normalization for chat output. Gemini sometimes returns
 * markdown despite the system prompt asking for plain prose. We strip header
 * hashes, normalize bullet markers to "• ", and drop trailing bullet asterisks
 * so the parser below treats the text as inline-only. The container uses
 * `whitespace-pre-wrap`, so line breaks survive.
 */
function normalizeMarkdownBlocks(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const headingStripped = line.replace(/^\s{0,3}#{1,6}\s+/, '');
      return headingStripped.replace(/^(\s*)(?:[*\-+]|\d+[.)])\s+/, '$1• ');
    })
    .join('\n');
}

/**
 * Inline markdown: **bold**, *italic* / _italic_, `code`. Returns a flat list
 * of React nodes. Citation tokens [src:id] are NOT processed here — they're
 * handled by the outer split.
 */
function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode {
  if (!text) return null;
  const tokens = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|(?<![A-Za-z0-9])[*_][^*_\n]+[*_](?![A-Za-z0-9]))/g);
  return tokens.map((tok, i) => {
    const key = `${keyPrefix}-${i}`;
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length >= 4) {
      return <strong key={key}>{tok.slice(2, -2)}</strong>;
    }
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length >= 2) {
      return (
        <code key={key} className="px-1 py-0.5 rounded bg-slate-100 text-slate-800 text-[12px]">
          {tok.slice(1, -1)}
        </code>
      );
    }
    if ((tok.startsWith('*') || tok.startsWith('_')) && tok.length >= 2 && tok[0] === tok[tok.length - 1]) {
      return <em key={key}>{tok.slice(1, -1)}</em>;
    }
    return <React.Fragment key={key}>{tok}</React.Fragment>;
  });
}

// Citation tokens come in two id schemes: prefixed ids ([ss:abc123]) and
// DOI-shaped workIds ([10.1093/wber/lhad029]) — most of the corpus uses DOIs.
// Match both; leave other brackets ([1], [sic]) as plain text.
const CITATION_SPLIT = /(\[(?:[a-z]{2,4}:[a-zA-Z0-9_-]+|10\.\d{4,9}\/[^\[\]\s]+)\])/g;
const CITATION_MATCH = /^\[((?:[a-z]{2,4}:[a-zA-Z0-9_-]+|10\.\d{4,9}\/[^\[\]\s]+))\]$/;

// "Last" from "First Last" or "Last, First" author strings.
function lastName(author: string): string {
  const comma = author.indexOf(',');
  if (comma >= 0) return author.slice(0, comma).trim();
  const words = author.trim().split(/\s+/);
  return words[words.length - 1] || author.trim();
}

// Author-year chip label: "Maruyama & Kurosaki (2022)" / "Agüero et al. (2024)".
function citationLabel(row: EvidenceRow): string {
  const authors = Array.isArray(row.authors) ? row.authors.filter(Boolean) : [];
  const year = row.year ? ` (${row.year})` : '';
  if (authors.length === 0) {
    const t = (row.title || '').trim();
    return t ? `${t.slice(0, 40)}${t.length > 40 ? '…' : ''}${year}` : row.workId;
  }
  if (authors.length === 1) return `${lastName(authors[0])}${year}`;
  if (authors.length === 2) return `${lastName(authors[0])} & ${lastName(authors[1])}${year}`;
  return `${lastName(authors[0])} et al.${year}`;
}

// Same cross-link behavior as BriefView's CitationRef: scroll the evidence
// table row into view and flash it teal so the user can locate the paper.
function scrollToEvidenceRow(workId: string): void {
  const row = document.querySelector<HTMLTableRowElement>(`[data-work-id="${workId}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  row.style.backgroundColor = 'rgb(204, 251, 241)';
  row.style.transition = '';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      row.style.transition = 'background-color 1.2s ease';
      row.style.backgroundColor = '';
    });
  });
  setTimeout(() => { row.style.transition = ''; }, 1400);
}

function renderModelContent(text: string, rowsById?: Map<string, EvidenceRow>): React.ReactNode {
  const normalized = normalizeMarkdownBlocks(text);
  const parts = normalized.split(CITATION_SPLIT);
  return parts.map((part, i) => {
    const match = part.match(CITATION_MATCH);
    if (match) {
      const id = match[1];
      const row = rowsById?.get(id) ?? rowsById?.get(id.toLowerCase());
      return (
        <span
          key={i}
          className={`inline-block bg-teal-100 text-teal-800 text-[10px] font-bold px-1.5 py-0.5 rounded-md mx-0.5${row ? ' cursor-pointer hover:bg-teal-200' : ''}`}
          title={row ? `${row.title}${row.sourceName ? ` — ${row.sourceName}` : ''} [${id}]` : `Citation: ${id}`}
          onClick={row ? () => scrollToEvidenceRow(row.workId) : undefined}
        >
          {row ? citationLabel(row) : id}
        </span>
      );
    }
    return <React.Fragment key={i}>{renderInlineMarkdown(part, `t${i}`)}</React.Fragment>;
  });
}

/**
 * Presentational chat thread. Renders the conversation history and
 * streaming state for the current brief. All state lives in App.tsx;
 * input is handled by the unified top search bar.
 */
const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  isLoading,
  streamingText,
  error,
  onDeleteMessage,
  onRetryMessage,
  evidenceRows,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // workId → row lookup for citation chips. Also keyed by lowercased DOI so a
  // model that cites [10.1086/721768] with different casing still resolves.
  const rowsById = useMemo(() => {
    const m = new Map<string, EvidenceRow>();
    for (const row of evidenceRows ?? []) {
      if (!row?.workId) continue;
      m.set(row.workId, row);
      m.set(row.workId.toLowerCase(), row);
      if (row.doi) m.set(row.doi.toLowerCase(), row);
    }
    return m;
  }, [evidenceRows]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const hasMessages = messages.length > 0 || isLoading;

  if (!hasMessages && !error) return null;

  return (
    <div className="space-y-4">
      {/* Message thread */}
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`group flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`relative max-w-[85%] rounded-xl px-5 py-3 text-sm whitespace-pre-wrap shadow-sm ${
              msg.role === 'user'
                ? 'bg-teal-600 text-white'
                : 'bg-white text-slate-700 border border-slate-200'
            }`}
          >
            {msg.role === 'model' ? renderModelContent(msg.content, rowsById) : msg.content}
            {!msg.id.startsWith('pending-') && (
              <>
                <button
                  onClick={() => onDeleteMessage(msg.id)}
                  className={`absolute -top-2 ${
                    msg.role === 'user' ? '-left-2' : '-right-2'
                  } hidden group-hover:flex items-center justify-center w-5 h-5 rounded-full bg-white border border-slate-200 shadow-sm text-slate-400 hover:text-rose-500 hover:border-rose-300 transition`}
                  title="Delete message"
                  aria-label="Delete message"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
                {msg.role === 'user' && onRetryMessage && (
                  <button
                    onClick={() => onRetryMessage(msg.id)}
                    className="absolute -bottom-2 -left-2 hidden group-hover:flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-slate-200 shadow-sm text-[10px] font-semibold text-slate-500 hover:text-teal-700 hover:border-teal-300 transition"
                    title="Retry — drops this question + the response and puts the question back in the input for editing"
                    aria-label="Retry this question"
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                    Retry
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      ))}

      {/* Streaming response (in-flight) */}
      {isLoading && streamingText && (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-xl bg-white text-slate-700 border border-slate-200 shadow-sm px-5 py-3 text-sm whitespace-pre-wrap">
            {renderModelContent(streamingText, rowsById)}
            <span className="inline-block w-1.5 h-4 bg-teal-500 animate-pulse ml-0.5 rounded-sm" />
          </div>
        </div>
      )}

      {/* Loading indicator (waiting for first chunk) */}
      {isLoading && !streamingText && (
        <div className="flex justify-start">
          <div className="rounded-xl bg-white border border-slate-200 shadow-sm px-5 py-3 flex items-center gap-2">
            <svg className="animate-spin h-3.5 w-3.5 text-teal-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-xs text-slate-500">Thinking...</span>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
};

export default ChatPanel;
