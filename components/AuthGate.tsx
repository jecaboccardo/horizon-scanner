import React, { useState } from 'react';
import { supabase } from '../services/supabaseClient';
import { track } from '../services/analytics';

type AuthMode = 'login' | 'signup' | 'forgot';

interface AuthGateProps {
  onAuthenticated: () => void;
}

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  ) : (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  );
}

const AuthGate: React.FC<AuthGateProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  function switchMode(next: AuthMode) {
    setMode(next);
    setError('');
    setMessage('');
    setPassword('');
    setShowPassword(false);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      if (mode === 'login') {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) {
          track('auth.login_failed', { severity: 'critical', error_message: signInError.message });
          setError(signInError.message);
          return;
        }
        track('auth.login_success', { severity: 'info' });
        onAuthenticated();

      } else if (mode === 'signup') {
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) {
          track('auth.signup_failed', { severity: 'warning', error_message: signUpError.message });
          setError(signUpError.message);
          return;
        }
        track('auth.signup', { severity: 'info' });
        if (signUpData.session) {
          onAuthenticated();
        } else {
          setMessage('Account created. Check your email to confirm, then sign in.');
          switchMode('login');
        }

      } else if (mode === 'forgot') {
        const redirectTo = `${window.location.origin}`;
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        if (resetError) {
          track('auth.reset_failed', { severity: 'warning', error_message: resetError.message });
          // Email sending may not be configured — guide user to contact admin
          setError('Password reset email could not be sent. Please contact your administrator to reset your password, or sign in and use the Account panel to change it.');
          return;
        }
        track('auth.reset_requested', { severity: 'info' });
        setMessage('Password reset email sent. Check your inbox.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(135deg,#118b97,#0f1d35)] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-xs uppercase tracking-[0.2em] text-cyan-200 mb-3">IADB Horizon Scanner</div>
          <h1 className="text-3xl font-black text-white">Evidence Intelligence</h1>
          <p className="mt-3 text-slate-300 text-sm">
            Structured, citation-grounded answers for policy questions — in under 10 seconds.
          </p>
        </div>

        <div className="bg-white rounded-xl p-8 shadow-2xl">

          {mode !== 'forgot' && (
            <div className="flex rounded-full bg-slate-100 p-1 mb-6">
              <button
                type="button"
                onClick={() => switchMode('login')}
                className={`flex-1 rounded-full py-2 text-sm font-semibold transition ${
                  mode === 'login' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => switchMode('signup')}
                className={`flex-1 rounded-full py-2 text-sm font-semibold transition ${
                  mode === 'signup' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                }`}
              >
                Create account
              </button>
            </div>
          )}

          {mode === 'forgot' && (
            <div className="mb-6">
              <h2 className="text-lg font-bold text-slate-900">Reset your password</h2>
              <p className="text-sm text-slate-500 mt-1">Enter your email and we'll send you a reset link.</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                placeholder="you@example.com"
              />
            </div>

            {mode !== 'forgot' && (
              <div>
                <label htmlFor="password" className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    minLength={6}
                    className="w-full rounded-xl border border-slate-200 px-4 py-3 pr-11 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    placeholder={mode === 'signup' ? 'At least 6 characters' : ''}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition"
                    tabIndex={-1}
                  >
                    <EyeIcon open={showPassword} />
                  </button>
                </div>
                {/* Forgot password hidden — SMTP not configured; use admin-generated reset link */}
              </div>
            )}

            {error && (
              <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {message && (
              <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
                {message}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-full bg-[#0f1d35] py-3 text-sm font-semibold text-white disabled:opacity-50 transition hover:bg-[#0a1628]"
            >
              {loading
                ? 'Please wait...'
                : mode === 'login' ? 'Sign in'
                : mode === 'signup' ? 'Create account'
                : 'Send reset link'}
            </button>

            {mode === 'forgot' && (
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="w-full text-center text-sm text-slate-500 hover:text-slate-700 transition"
              >
                Back to sign in
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
};

export default AuthGate;
