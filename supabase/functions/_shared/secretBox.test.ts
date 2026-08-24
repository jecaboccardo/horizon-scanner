import { assertEquals, assertRejects } from "jsr:@std/assert";
import { encryptSecret, decryptSecret } from "./secretBox.ts";

const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7))); // 32 bytes b64

Deno.test("encrypt then decrypt round-trips", async () => {
  const { ct, iv } = await encryptSecret("hsk-or-gemini-key-12345", SECRET);
  const back = await decryptSecret(ct, iv, SECRET);
  assertEquals(back, "hsk-or-gemini-key-12345");
});

Deno.test("each encryption uses a fresh IV (ciphertext differs)", async () => {
  const a = await encryptSecret("same-plaintext", SECRET);
  const b = await encryptSecret("same-plaintext", SECRET);
  assertEquals(a.iv === b.iv, false);
  assertEquals(a.ct === b.ct, false);
});

Deno.test("tampered ciphertext fails to decrypt", async () => {
  const { ct, iv } = await encryptSecret("secret", SECRET);
  const flipped = ct.slice(0, -2) + (ct.endsWith("A") ? "B" : "A") + ct.slice(-1);
  await assertRejects(() => decryptSecret(flipped, iv, SECRET));
});
