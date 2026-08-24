// AES-256-GCM encryption for provider API keys at rest. The master key comes
// from SYNTHESIS_KEY_SECRET (32 raw bytes, base64). No external dependency —
// crypto.subtle is available under both Deno (prod) and Node (tooling).

function readEnv(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const d = (globalThis as any).Deno;
    if (d?.env?.get) return d.env.get(name) ?? undefined;
  } catch { /* not Deno */ }
  // deno-lint-ignore no-explicit-any
  return (globalThis as any).process?.env?.[name];
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function importKey(masterB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(masterB64);
  if (raw.length !== 32) {
    throw new Error(`SYNTHESIS_KEY_SECRET must be 32 bytes (got ${raw.length})`);
  }
  return await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Resolve the master secret, throwing a clear error if unset. */
export function getMasterSecret(): string {
  const s = readEnv("SYNTHESIS_KEY_SECRET");
  if (!s) throw new Error("SYNTHESIS_KEY_SECRET is not set");
  return s;
}

export async function encryptSecret(
  plaintext: string,
  masterB64: string = getMasterSecret(),
): Promise<{ ct: string; iv: string }> {
  const key = await importKey(masterB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, enc as BufferSource);
  return { ct: bytesToB64(new Uint8Array(buf)), iv: bytesToB64(iv) };
}

export async function decryptSecret(
  ctB64: string,
  ivB64: string,
  masterB64: string = getMasterSecret(),
): Promise<string> {
  const key = await importKey(masterB64);
  const buf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(ivB64) as BufferSource },
    key,
    b64ToBytes(ctB64) as BufferSource,
  );
  return new TextDecoder().decode(buf);
}
