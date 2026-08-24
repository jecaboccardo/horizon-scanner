import { adminClient, createUserClient } from "./supabase.ts";
import { SupabaseClient } from "@supabase/supabase-js";

interface AuthResult {
  user: Record<string, unknown> | null;
  db: SupabaseClient | null;
  error: string | null;
  /** True when the request authenticated via a durable plugin key (hsk_...).
   *  Such requests are SCOPED to the plugin endpoint allowlist in the handler
   *  and never granted admin. */
  viaPluginKey?: boolean;
}

/** Prefix that marks a durable plugin key (vs a Supabase JWT). */
export const PLUGIN_KEY_PREFIX = "hsk_";

/** SHA-256(rawKey) as lowercase hex — the only form stored in plugin_keys. */
export async function hashPluginKey(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function authenticateRequest(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return { user: null, db: null, error: "No token" };
  }

  // --- Durable plugin key path (additive — only for hsk_-prefixed tokens) ---
  if (token.startsWith(PLUGIN_KEY_PREFIX)) {
    const hash = await hashPluginKey(token);
    const { data, error } = await adminClient
      .from("plugin_keys")
      .select("id, user_id, tenant_id")
      .eq("token_hash", hash)
      .is("revoked_at", null)
      .maybeSingle();
    if (error || !data) {
      return { user: null, db: null, error: "Invalid or revoked plugin key" };
    }
    // Fire-and-forget last-used stamp; never blocks/throws on the hot path.
    try { void adminClient.from("plugin_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id); } catch { /* ignore */ }
    // Minimal user: id only (no email → never admin). db = adminClient; the
    // plugin endpoints filter by tenant/user explicitly, and the handler's
    // allowlist confines plugin-key requests to those endpoints.
    const user = { id: data.user_id, plugin_key: true, tenant_id: data.tenant_id } as Record<string, unknown>;
    return { user, db: adminClient, error: null, viaPluginKey: true };
  }

  const { data: { user }, error } = await adminClient.auth.getUser(token);

  if (error || !user) {
    return { user: null, db: null, error: "Invalid or expired token" };
  }

  const db = createUserClient(token);
  return { user: user as unknown as Record<string, unknown>, db, error: null };
}
