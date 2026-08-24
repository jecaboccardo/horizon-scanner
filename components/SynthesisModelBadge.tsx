import { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
};
function label(m?: string): string {
  return (m && MODEL_LABELS[m]) || m || 'the default model';
}

interface Access {
  status: 'granted' | 'default';
  model?: string;
  grantedByEmail?: string | null;
  ownKey?: boolean;
  defaultModel?: string;
  requestFromEmail?: string | null;
}

/**
 * Pre-generation badge: shows which synthesis model the current user's next
 * generation will use, and its provenance. Granted → the configured model +
 * who granted it; not granted → the default model + a generic "request access"
 * line naming the admin to ask. Renders for every logged-in user (incl. owner).
 */
export default function SynthesisModelBadge({ className = '' }: { className?: string }) {
  const [a, setA] = useState<Access | null>(null);
  useEffect(() => {
    let on = true;
    apiClient.getSynthesisAccess().then((r) => { if (on) setA(r); }).catch(() => {});
    return () => { on = false; };
  }, []);
  if (!a) return null;

  if (a.status === 'granted') {
    const prov = a.ownKey
      ? 'your team key'
      : a.grantedByEmail ? `access granted by ${a.grantedByEmail}` : 'team key';
    return (
      <div className={`flex items-center gap-1.5 text-[11px] text-teal-700 bg-teal-50 border border-teal-200 rounded-full px-2.5 py-1 w-fit ${className}`}>
        <span aria-hidden>✨</span>
        <span>Synthesis model: <strong>{label(a.model)}</strong> · {prov}</span>
      </div>
    );
  }

  return (
    <div className={`text-[11px] leading-snug text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 ${className}`}>
      Synthesis model: <strong>{label(a.defaultModel)}</strong> (default).
      {a.requestFromEmail
        ? <> For higher-quality, better-grounded briefs, request Claude access from <strong>{a.requestFromEmail}</strong>.</>
        : null}
    </div>
  );
}
