import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../services/supabaseClient';
import { logEvent } from '../services/analytics';
import ClaudeCodeSetup from './ClaudeCodeSetup';

interface AccountPanelProps {
  email: string;
  onClose: () => void;
  /** Admin-gated destinations (Grant access, Admin Audit, Pilot Monitor). On
   *  mobile the bottom nav only carries the 3 primary tabs, so these live here
   *  — without them a byok_admin (e.g. rafaelde) can't reach Grant access on a
   *  phone. Empty/omitted for non-privileged users → the section is hidden. */
  navItems?: { key: string; label: string }[];
  onNavigate?: (key: string) => void;
}

const AccountPanel: React.FC<AccountPanelProps> = ({ email, onClose, navItems, onNavigate }) => {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [onClose]);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setMessage({ text: 'Passwords do not match.', ok: false });
      return;
    }
    if (newPassword.length < 8) {
      setMessage({ text: 'Password must be at least 8 characters.', ok: false });
      return;
    }
    setSaving(true);
    setMessage(null);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSaving(false);
    if (error) {
      setMessage({ text: error.message, ok: false });
      logEvent({ eventType: 'auth.password_changed', status: 'failed', error: 'update_failed' });
    } else {
      setMessage({ text: 'Password updated successfully.', ok: true });
      setNewPassword('');
      setConfirmPassword('');
      logEvent({ eventType: 'auth.password_changed', status: 'completed' });
    }
  }

  const displayName = email.split('@')[0];

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-2 w-72 bg-white rounded-xl shadow-xl border border-slate-200 z-50 overflow-hidden"
    >
      {/* User info */}
      <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-teal-600 flex items-center justify-center text-white text-sm font-bold shrink-0">
            {displayName[0]?.toUpperCase() ?? '?'}
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-slate-800 truncate">{displayName}</div>
            <div className="text-[11px] text-slate-500 truncate">{email}</div>
          </div>
        </div>
      </div>

      {/* Admin destinations — mobile only (desktop has these in the top tab bar).
          Rendered only when the caller passes privileged navItems. */}
      {navItems && navItems.length > 0 && onNavigate && (
        <div className="px-4 py-3 border-b border-slate-100 space-y-1">
          <div className="text-[11px] uppercase tracking-widest font-bold text-slate-400 mb-1">Admin</div>
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => { onNavigate(item.key); onClose(); }}
              className="w-full text-left rounded-lg px-3 py-2 text-[13px] font-semibold text-slate-700 hover:bg-teal-50 hover:text-teal-700 transition"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* Change password */}
      <form onSubmit={handleChangePassword} className="px-4 py-3 space-y-2.5">
        <div className="text-[11px] uppercase tracking-widest font-bold text-slate-400 mb-1">Change password</div>

        <div>
          <label className="text-[11px] text-slate-500 block mb-0.5">New password</label>
          <input
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            placeholder="Min. 8 characters"
            className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-400 placeholder:text-slate-300"
            autoComplete="new-password"
          />
        </div>

        <div>
          <label className="text-[11px] text-slate-500 block mb-0.5">Confirm password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder="Repeat new password"
            className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-400 placeholder:text-slate-300"
            autoComplete="new-password"
          />
        </div>

        {message && (
          <p className={`text-[12px] ${message.ok ? 'text-emerald-600' : 'text-red-500'}`}>
            {message.text}
          </p>
        )}

        <button
          type="submit"
          disabled={saving || !newPassword || !confirmPassword}
          className="w-full rounded-lg bg-teal-600 text-white text-[13px] font-semibold py-1.5 hover:bg-teal-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Updating…' : 'Update password'}
        </button>
      </form>

      {/* Claude Code plugin setup */}
      <div className="px-4 py-3 border-t border-slate-100 space-y-2">
        <div className="text-[11px] uppercase tracking-widest font-bold text-slate-400">Claude Code plugin</div>
        <ClaudeCodeSetup compact />
      </div>
    </div>
  );
};

export default AccountPanel;
