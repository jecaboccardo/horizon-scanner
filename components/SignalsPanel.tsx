import React from 'react';
import { SignalItem } from '../types';

interface SignalsPanelProps {
  policy: SignalItem[];
  buzz: SignalItem[];
  policyEnabled: boolean;
  buzzEnabled: boolean;
  isLoading: boolean;
  error: string | null;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

const ExternalLinkIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const Skeleton: React.FC<{ label: string }> = ({ label }) => (
  <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-6 flex items-center justify-center gap-3 text-slate-500 text-sm">
    <svg className="animate-spin h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
    {label}
  </div>
);

interface SectionProps {
  title: string;
  caption: string;
  badgeCls: string;
  items: SignalItem[];
  emptyText: string;
}

const Section: React.FC<SectionProps> = ({ title, caption, badgeCls, items, emptyText }) => (
  <div className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden">
    <div className="px-6 py-4 border-b border-slate-100">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] uppercase tracking-[0.14em] font-bold px-2 py-1 rounded-md ${badgeCls}`}>{title}</span>
          <span className="text-[11px] text-slate-400">{items.length} item{items.length === 1 ? '' : 's'}</span>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">{caption}</p>
    </div>
    {items.length === 0 ? (
      <div className="px-6 py-6 text-center text-xs text-slate-400 italic">{emptyText}</div>
    ) : (
      <div className="divide-y divide-slate-100">
        {items.map((item) => (
          <div key={item.id} className="px-6 py-4 hover:bg-slate-50 transition">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  {item.domain && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">{item.domain}</span>
                  )}
                  {item.publishedDate && (
                    <span className="text-[11px] text-slate-400">{formatDate(item.publishedDate)}</span>
                  )}
                  {item.author && (
                    <span className="text-[11px] text-slate-400 truncate">· {item.author}</span>
                  )}
                </div>
                <a
                  href={item.url ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-semibold text-slate-800 hover:text-teal-700 leading-snug block mb-1"
                >
                  {item.title}
                </a>
                {item.snippet && (
                  <p className="text-xs text-slate-600 leading-relaxed line-clamp-3">{item.snippet}</p>
                )}
              </div>
              {item.url && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 flex items-center gap-1 text-xs text-slate-400 hover:text-teal-700 transition mt-0.5"
                  aria-label="Open source"
                >
                  <ExternalLinkIcon />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    )}
  </div>
);

const SignalsPanel: React.FC<SignalsPanelProps> = ({ policy, buzz, policyEnabled, buzzEnabled, isLoading, error }) => {
  if (!policyEnabled && !buzzEnabled) return null;

  if (isLoading) {
    return <Skeleton label="Searching signals…" />;
  }

  if (error) {
    return (
      <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-6 text-sm text-rose-600">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500 font-bold">Signals</span>
        <span className="text-[11px] text-slate-400">non-corpus, non-peer-reviewed inputs</span>
      </div>

      {policyEnabled && (
        <Section
          title="Policy & grey lit"
          caption="Working papers, policy briefs, and institutional reports from a curated whitelist (IADB, World Bank, IMF, OECD, CGD, NBER, IZA, SSRN, CEPAL, PAHO, WHO, and more). Last 5 years."
          badgeCls="bg-teal-50 text-teal-700 border border-teal-200"
          items={policy}
          emptyText="No policy & grey lit results in the whitelisted sources."
        />
      )}

      {buzzEnabled && (
        <Section
          title="Buzz · 30 days"
          caption="Open-web mentions in news, blogs, and commentary from the last 30 days. Useful for spotting what's trending; not vetted, not peer-reviewed."
          badgeCls="bg-amber-50 text-amber-700 border border-amber-200"
          items={buzz}
          emptyText="No buzz in the last 30 days."
        />
      )}
    </div>
  );
};

export default SignalsPanel;
