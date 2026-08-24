import React, { useEffect, useMemo, useState } from 'react';
import { AlertSubscription, Work } from '../types';
import { apiClient } from '../services/apiClient';

interface FollowDigestPanelProps {
  subscriptions: AlertSubscription[];
  onCreateSubscription: (payload: { label: string; type: 'topic' | 'author' | 'search'; cadence: 'daily' | 'weekly'; topic?: string; query?: string }) => void;
  onDeleteSubscription?: (id: string) => void;
}

interface SignalItemDTO {
  id: string;
  title: string;
  url: string | null;
  snippet: string | null;
  publishedDate: string | null;
  domain: string | null;
  author: string | null;
  sourceType: 'news' | 'blog' | 'x' | 'other';
}

interface DigestRow {
  subscription: AlertSubscription;
  updates: Work[];
  signals: SignalItemDTO[];
  totalThisWeek: number;
}

const SIGNAL_FEEDS_TOOLTIP = [
  'Curated dev/policy RSS feeds:',
  '• IADB blogs',
  '• World Bank blogs',
  '• CGD',
  '• VoxDev',
  '• VoxEU (CEPR)',
  '• IMF blog',
  '• Brookings global-dev',
  '• NBER new papers',
  '• 3ie',
  '• IZA discussion papers',
  '• ILO',
].join('\n');

const SOURCE_OPTIONS: Array<{ value: string; label: string; lane: 'evidence' | 'signals'; hint?: string }> = [
  { value: 'journals', label: 'Journals', lane: 'evidence', hint: 'Peer-reviewed journal articles' },
  { value: 'policy_papers', label: 'Policy papers', lane: 'evidence', hint: 'IADB, World Bank, IMF, OECD, CGD, Brookings, ILO, etc.' },
  { value: 'working_papers', label: 'Working papers', lane: 'evidence', hint: 'NBER, IZA, SSRN, RePEc, CEPR working papers' },
  { value: 'signals', label: 'Signals', lane: 'signals', hint: SIGNAL_FEEDS_TOOLTIP },
];

function signalSourceColor(t: SignalItemDTO['sourceType']): string {
  if (t === 'x') return 'bg-slate-900 text-white';
  if (t === 'news') return 'bg-rose-100 text-rose-800';
  if (t === 'blog') return 'bg-violet-100 text-violet-800';
  return 'bg-slate-100 text-slate-600';
}

const REGION_OPTIONS = ['Latin America', 'Caribbean', 'OECD', 'Sub-Saharan Africa', 'Asia'];
const WINDOW_DAYS = 7; // fixed — Follow always shows last 7 days

function smsBadgeColor(level: number | null | undefined): string {
  if (level == null) return 'bg-slate-100 text-slate-600';
  if (level >= 5) return 'bg-emerald-100 text-emerald-800';
  if (level >= 4) return 'bg-teal-100 text-teal-800';
  if (level >= 3) return 'bg-sky-100 text-sky-800';
  if (level >= 2) return 'bg-amber-100 text-amber-800';
  return 'bg-slate-100 text-slate-600';
}

function relativeDate(iso?: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const days = Math.round((Date.now() - then) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const FollowDigestPanel: React.FC<FollowDigestPanelProps> = ({ subscriptions, onCreateSubscription, onDeleteSubscription }) => {
  const [label, setLabel] = useState('');
  const [query, setQuery] = useState('');

  // Filter state — Follow keeps a minimal set: Time period, Region, Source.
  // Methodology + Tier filters were removed (analyst workflow showed they
  // weren't being used; Source + Region are the load-bearing knobs).
  const [regions, setRegions] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);

  // Digest state
  const [digest, setDigest] = useState<DigestRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtersKey = useMemo(
    () => JSON.stringify({ regions, sources, subCount: subscriptions.length }),
    [regions, sources, subscriptions.length],
  );

  useEffect(() => {
    let cancelled = false;
    if (subscriptions.length === 0) {
      setDigest([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    apiClient
      .getFollowDigest({ windowDays: WINDOW_DAYS, limit: 5, regions, sources })
      .then((resp) => {
        if (cancelled) return;
        setDigest(resp.subscriptions);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load digest');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filtersKey]);

  function toggleInArray(arr: string[], value: string, setter: (v: string[]) => void) {
    setter(arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]);
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[0.7fr_1.3fr]">
      {/* LEFT: subscription creator + list */}
      <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
        <div className="text-xs uppercase tracking-[0.2em] text-teal-700 font-bold mb-4">Follow Topics or Searches</div>
        <div className="space-y-3">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Label (e.g. CCT in education)"
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition"
          />
          <textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search query, topic, or author to follow"
            className="w-full rounded-xl border border-slate-200 px-4 py-3 min-h-24 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition"
          />
          <button
            onClick={() => {
              if (!label.trim() || !query.trim()) return;
              onCreateSubscription({ label, type: 'search', cadence: 'weekly', query });
              setLabel('');
              setQuery('');
            }}
            className="rounded-full bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 transition"
          >
            Create Follow
          </button>
        </div>

        {subscriptions.length > 0 ? (
          <div className="mt-6 space-y-2">
            {subscriptions.map((subscription) => (
              <div key={subscription.id} className="group flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 hover:border-slate-300 transition">
                <div>
                  <div className="font-semibold text-slate-900 text-sm">{subscription.label}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{subscription.type} · {subscription.cadence}</div>
                </div>
                {onDeleteSubscription && (
                  <button
                    onClick={() => onDeleteSubscription(subscription.id)}
                    className="opacity-0 group-hover:opacity-100 text-xs text-rose-500 hover:text-rose-700 transition"
                    title="Unfollow"
                  >
                    Unfollow
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-6 rounded-xl border border-dashed border-slate-200 p-6 text-center">
            <p className="text-xs text-slate-400">No subscriptions yet. Create one above to track topics or authors.</p>
          </div>
        )}
      </section>

      {/* RIGHT: digest with filter bar */}
      <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs uppercase tracking-[0.2em] text-teal-700 font-bold">Last 7 Days</div>
          <div className="text-xs text-slate-400">Top 5 per follow · ranked by SMS × recency × citations</div>
        </div>

        {/* Filter bar */}
        <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 mb-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mr-1">Region</span>
            {REGION_OPTIONS.map((r) => (
              <button
                key={r}
                onClick={() => toggleInArray(regions, r, setRegions)}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
                  regions.includes(r)
                    ? 'bg-amber-600 text-white'
                    : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              >
                {r}
              </button>
            ))}
            {(regions.length + sources.length > 0) && (
              <button
                onClick={() => { setRegions([]); setSources([]); }}
                className="ml-auto text-xs text-slate-500 hover:text-slate-700 underline"
              >
                Clear filters
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mr-1">Source</span>
            {SOURCE_OPTIONS.map((opt) => {
              const active = sources.includes(opt.value);
              const tone = opt.lane === 'evidence' ? 'bg-emerald-600' : 'bg-slate-700';
              return (
                <button
                  key={opt.value}
                  onClick={() => toggleInArray(sources, opt.value, setSources)}
                  title={opt.hint || (opt.lane === 'evidence' ? 'Evidence lane' : 'Signals lane')}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
                    active
                      ? `${tone} text-white`
                      : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
            <span className="text-[10px] text-slate-400 ml-2">No selection = all sources</span>
          </div>
        </div>

        {/* Empty / loading / error / digest */}
        {subscriptions.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-200 p-12 text-center">
            <p className="text-slate-500 font-medium text-sm">No follows yet</p>
            <p className="text-slate-400 text-xs mt-1">Create a follow on the left to start tracking new evidence.</p>
          </div>
        )}

        {subscriptions.length > 0 && isLoading && (
          <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">
            Loading digest…
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700 mb-3">
            {error}
          </div>
        )}

        {!isLoading && !error && subscriptions.length > 0 && (
          <div className="space-y-5">
            {subscriptions.map((sub) => {
              const row = digest.find((d) => d.subscription.id === sub.id) ?? {
                subscription: sub,
                updates: [],
                signals: [],
                totalThisWeek: 0,
              };
              return (
              <div key={sub.id} className="rounded-xl border border-slate-200 overflow-hidden">
                <header className="flex items-center justify-between bg-slate-50 px-5 py-3 border-b border-slate-200">
                  <div>
                    <div className="text-sm font-bold text-slate-900">{row.subscription.label}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {row.subscription.type} · {row.updates.length} evidence · {row.signals.length} signals
                    </div>
                  </div>
                </header>

                {/* Evidence lane */}
                {row.updates.length > 0 && (
                  <div>
                    <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-wider text-emerald-700 font-bold">Evidence</div>
                    <ul className="divide-y divide-slate-100">
                      {row.updates.map((work) => (
                        <li key={work.id} className="px-5 py-3 hover:bg-slate-50 transition">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <a
                                href={work.url || work.openAccessPdfUrl || '#'}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm font-semibold text-slate-900 hover:text-teal-700 line-clamp-2"
                              >
                                {work.title}
                              </a>
                              <div className="text-[11px] text-slate-500 mt-1 truncate">
                                {(work.authors || []).slice(0, 3).join(', ')}
                                {(work.authors || []).length > 3 ? ' et al.' : ''}
                                {work.venue ? ` · ${work.venue}` : work.source ? ` · ${work.source}` : ''}
                                {work.year ? ` · ${work.year}` : ''}
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-1 shrink-0">
                              {work.smsLevel != null && (
                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${smsBadgeColor(work.smsLevel)}`}>
                                  SMS {work.smsLevel}
                                </span>
                              )}
                              <span className="text-[10px] text-slate-400">{relativeDate(work.publicationDate)}</span>
                            </div>
                          </div>
                          {work.methodologyDesign && (
                            <div className="text-[10px] text-slate-500 mt-1">
                              {work.methodologyDesign}{work.causalStrength ? ` · ${work.causalStrength}` : ''}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Signals lane */}
                {row.signals.length > 0 && (
                  <div className={row.updates.length > 0 ? 'border-t border-slate-200' : ''}>
                    <div className="px-5 pt-3 pb-1 flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-slate-700 font-bold">Signals</span>
                      <span className="text-[10px] text-slate-400">non-peer-reviewed · for context only</span>
                    </div>
                    <ul className="divide-y divide-slate-100">
                      {row.signals.map((sig) => (
                        <li key={sig.id} className="px-5 py-3 hover:bg-slate-50 transition">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <a
                                href={sig.url || '#'}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm font-semibold text-slate-900 hover:text-teal-700 line-clamp-2"
                              >
                                {sig.title}
                              </a>
                              <div className="text-[11px] text-slate-500 mt-1 truncate">
                                {sig.author ? `${sig.author} · ` : ''}{sig.domain || ''}
                              </div>
                              {sig.snippet && (
                                <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">{sig.snippet}</p>
                              )}
                            </div>
                            <div className="flex flex-col items-end gap-1 shrink-0">
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${signalSourceColor(sig.sourceType)}`}>
                                {sig.sourceType}
                              </span>
                              <span className="text-[10px] text-slate-400">{relativeDate(sig.publishedDate)}</span>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {row.updates.length === 0 && row.signals.length === 0 && (
                  <div className="px-5 py-8 text-center">
                    <p className="text-xs text-slate-500">No updates in the last {WINDOW_DAYS} days for this follow.</p>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Try clearing filters to see more results.
                    </p>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

export default FollowDigestPanel;
