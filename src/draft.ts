/** Signed preview state, not an authorization grant to unpublished records. */
export const DRAFT_COOKIE = "__Host-rebask_draft";
const encoder = new TextEncoder();
async function key(secret: string) {
  if (secret.length < 32)
    throw new Error("Draft signing secret must contain at least 32 characters");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
/** Call only AFTER app-owned authorization and CSRF checks. Secret is runtime-only. */
export async function createDraftCookie(
  secret: string,
  maxAge = 3600,
): Promise<string> {
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 86400)
    throw new Error("Draft lifetime must be 1–86400 seconds");
  const value = `${Math.floor(Date.now() / 1000) + maxAge}.${crypto.randomUUID()}`;
  const signature = base64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await key(secret),
        encoder.encode(value),
      ),
    ),
  );
  return `${DRAFT_COOKIE}=${value}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function clearDraftCookie(): string {
  return `${DRAFT_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
export async function verifyDraftCookie(
  request: Request,
  secret?: string,
): Promise<boolean> {
  if (!secret) return false;
  const cookies = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${DRAFT_COOKIE}=`));
  if (cookies.length !== 1) return false;
  const value = cookies[0]!.slice(DRAFT_COOKIE.length + 1);
  const match = /^(\d{10})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const remaining = Number(match[1]) - Math.floor(Date.now() / 1000);
  if (remaining <= 0 || remaining > 86400) return false;
  try {
    const signature = Uint8Array.from(
      atob(match[3]!.replaceAll("-", "+").replaceAll("_", "/") + "="),
      (c) => c.charCodeAt(0),
    );
    return await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      signature,
      encoder.encode(`${match[1]}.${match[2]}`),
    );
  } catch {
    return false;
  }
}
