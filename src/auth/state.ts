/**
 * Signed, opaque `state` blobs.
 *
 * The OAuth `state` parameter makes a browser round-trip through GitLab and back to our
 * `/callback`. We HMAC-sign it so the callback can (a) recover the original MCP request
 * tamper-proof and (b) reject forged callbacks — the signature is our CSRF guard. The body is
 * not secret (it rides in a URL), so we authenticate it rather than encrypt it.
 */

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Sign an arbitrary JSON-serializable payload into a `body.signature` token. */
export async function signState(payload: unknown, secret: string): Promise<string> {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

/** Verify a `body.signature` token; returns the decoded payload, or null if tampered/malformed. */
export async function verifyState<T>(token: string, secret: string): Promise<T | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await importKey(secret);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify("HMAC", key, base64UrlToBytes(sig), encoder.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as T;
  } catch {
    return null;
  }
}
