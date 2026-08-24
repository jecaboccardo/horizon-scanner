import React, { useState } from 'react';
import { ThreadTweet, Work } from '../types';

interface TwitterThreadViewProps {
  tweets: ThreadTweet[];
  citations: string[];
  worksById: Record<string, Work>;
  query: string;
}

const ROLE_LABELS: Record<ThreadTweet['role'], string> = {
  hook: 'Hook',
  context: 'Context',
  finding: 'Finding',
  method: 'Method',
  mechanism: 'Mechanism',
  caveat: 'Caveat',
  'so-what': 'So what',
};

function formatCharCount(text: string): { count: number; tone: 'ok' | 'warn' | 'over' } {
  const count = text.length;
  if (count > 280) return { count, tone: 'over' };
  if (count > 240) return { count, tone: 'warn' };
  return { count, tone: 'ok' };
}

const TwitterThreadView: React.FC<TwitterThreadViewProps> = ({
  tweets,
  citations,
  worksById,
  query,
}) => {
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }

  async function copyTweet(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Tweet copied');
    } catch {
      showToast('Copy failed');
    }
  }

  async function copyFullThread() {
    const joined = tweets
      .map((t, i) => `${i + 1}/${tweets.length} ${t.text}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(joined);
      showToast('Thread copied');
    } catch {
      showToast('Copy failed');
    }
  }

  if (!tweets || tweets.length === 0) {
    return (
      <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm text-center">
        <p className="text-slate-500 text-sm">
          No thread generated yet. Try switching to another persona and back, or re-running the search.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl bg-gradient-to-br from-sky-600 to-indigo-700 text-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-sky-200 mb-2">
              Econ Twitter Thread
            </div>
            <h2 className="text-xl font-bold max-w-3xl leading-snug">{query}</h2>
            <p className="text-sm text-sky-100 mt-2 max-w-2xl">
              {tweets.length} tweets, generated from the retrieved evidence.
            </p>
          </div>
          <button
            onClick={() => void copyFullThread()}
            className="rounded-full bg-white text-sky-700 px-4 py-2 text-sm font-semibold hover:bg-sky-50 transition"
          >
            Copy thread
          </button>
        </div>
      </section>

      <section className="rounded-xl bg-white border border-slate-200 shadow-sm divide-y divide-slate-100">
        {tweets.map((tweet, i) => {
          const { count, tone } = formatCharCount(tweet.text);
          const toneClass =
            tone === 'over' ? 'text-rose-600' : tone === 'warn' ? 'text-amber-600' : 'text-slate-400';
          return (
            <div key={i} className="p-5 flex gap-4 group hover:bg-slate-50/50 transition">
              <div className="flex flex-col items-center shrink-0 pt-1">
                <div className="w-9 h-9 rounded-full bg-sky-100 text-sky-700 flex items-center justify-center text-sm font-bold">
                  {i + 1}
                </div>
                {i < tweets.length - 1 && (
                  <div className="w-px flex-1 bg-slate-200 mt-2" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] uppercase tracking-widest text-sky-700 font-bold">
                    {ROLE_LABELS[tweet.role] || tweet.role}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs tabular-nums ${toneClass}`}>{count}/280</span>
                    <button
                      onClick={() => void copyTweet(tweet.text)}
                      className="opacity-0 group-hover:opacity-100 text-xs text-slate-500 hover:text-sky-700 font-semibold transition"
                    >
                      Copy
                    </button>
                  </div>
                </div>
                <p className="text-slate-800 leading-relaxed whitespace-pre-wrap">{tweet.text}</p>
              </div>
            </div>
          );
        })}
      </section>

      {citations && citations.length > 0 && (
        <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
          <div className="text-xs uppercase tracking-[0.2em] text-slate-500 font-bold mb-3">
            Citations
          </div>
          <ul className="space-y-2 text-sm text-slate-700">
            {citations.map((id) => {
              const work = worksById[id];
              if (!work) return (
                <li key={id} className="text-slate-400 text-xs">{id}</li>
              );
              return (
                <li key={id}>
                  <div className="font-semibold">{work.title}</div>
                  <div className="text-xs text-slate-500">
                    {work.authors?.slice(0, 3).join(', ')}{work.authors?.length > 3 ? ' et al.' : ''}
                    {work.year ? ` (${work.year})` : ''}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-full bg-slate-900 text-white px-5 py-2.5 text-sm font-medium shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
};

export default TwitterThreadView;
