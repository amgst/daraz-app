import crypto from "node:crypto";

// Signed, stateless CSRF token for the Daraz OAuth redirect. Daraz calls the
// callback URL as a plain top-level browser navigation (no Shopify session
// token available), so the target shop has to travel in `state` itself -
// this HMAC lets the callback trust it without a server-side lookup.
function getSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_API_SECRET environment variable is not set");
  }
  return secret;
}

export function createState(shop: string): string {
  const nonce = crypto.randomBytes(8).toString("hex");
  const payload = `${shop}:${nonce}:${Date.now()}`;
  const signature = crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("hex");
  return Buffer.from(`${payload}:${signature}`).toString("base64url");
}

const MAX_STATE_AGE_MS = 10 * 60 * 1000; // 10 minutes to complete the OAuth redirect

export function verifyState(state: string): { shop: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(state, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length !== 4) return null;
  const [shop, nonce, timestampStr, signature] = parts;
  const payload = `${shop}:${nonce}:${timestampStr}`;
  const expected = crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("hex");

  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > MAX_STATE_AGE_MS) {
    return null;
  }

  return { shop };
}
