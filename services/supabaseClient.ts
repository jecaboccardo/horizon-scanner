/**
 * services/supabaseClient.ts
 *
 * Singleton Supabase browser client for frontend auth.
 *
 * Uses @supabase/supabase-js v2. Reads project URL and anon key from
 * Vite environment variables (set in .env as VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY).
 *
 * This client is for auth only on the frontend — sign up, sign in, sign out,
 * and reading the session token to pass as a Bearer token to the API server.
 *
 * It does NOT query Supabase tables directly from the frontend — all data
 * access goes through the Node.js API server which enforces RLS.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl) {
  throw new Error('[supabaseClient.ts] VITE_SUPABASE_URL is not set. Add it to your .env file.');
}
if (!supabaseAnonKey) {
  throw new Error('[supabaseClient.ts] VITE_SUPABASE_ANON_KEY is not set. Add it to your .env file.');
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);
