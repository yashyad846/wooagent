import { createHmac, randomBytes } from "node:crypto";
import type { ApiKey, SigningMode } from "./settings.js";

/**
 * WooCommerce accepts HTTP Basic over TLS, and one-legged OAuth 1.0a when the
 * store is plain HTTP (because Basic over HTTP would leak the key). This module
 * is the only place that knows which, and how to produce the signature.
 */

const UNRESERVED_BY_OAUTH = /[!'()*]/g;

/** encodeURIComponent is not quite RFC 3986: these five characters stay literal. */
export function percentEncode(raw: string): string {
  return encodeURIComponent(raw).replace(
    UNRESERVED_BY_OAUTH,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode every pair, then sort by encoded key and encoded value, as OAuth 1.0a §3.4.1.3.2 requires. */
export function canonicalParams(pairs: Iterable<readonly [string, string]>): string {
  const encoded = [...pairs].map(([name, value]) => [percentEncode(name), percentEncode(value)] as const);
  encoded.sort(([aName, aValue], [bName, bValue]) => {
    if (aName !== bName) return aName < bName ? -1 : 1;
    if (aValue !== bValue) return aValue < bValue ? -1 : 1;
    return 0;
  });
  return encoded.map(([name, value]) => `${name}=${value}`).join("&");
}

export function signatureBase(method: string, target: URL, pairs: Iterable<readonly [string, string]>): string {
  const bare = `${target.protocol}//${target.host}${target.pathname}`;
  return [method.toUpperCase(), percentEncode(bare), percentEncode(canonicalParams(pairs))].join("&");
}

/**
 * One-legged OAuth: there is no token, so the signing key is the consumer secret
 * followed by an empty token component -- hence the trailing "&".
 */
export function hmacSignature(base: string, secret: string): string {
  return createHmac("sha256", `${secret}&`).update(base).digest("base64");
}

export function pickMode(mode: SigningMode, target: URL): Exclude<SigningMode, "auto"> {
  if (mode !== "auto") return mode;
  return target.protocol === "https:" ? "header" : "query";
}

/**
 * Credentials the request needs. For "query" mode the signature parameters are
 * written onto `target` in place, so the caller must pass the URL it will fetch.
 */
export function authorize(
  method: string,
  target: URL,
  apiKey: ApiKey,
  mode: SigningMode,
): Record<string, string> {
  if (pickMode(mode, target) === "header") {
    const pair = Buffer.from(`${apiKey.key}:${apiKey.secret}`, "utf8").toString("base64");
    return { Authorization: `Basic ${pair}` };
  }

  const oauth: Record<string, string> = {
    oauth_consumer_key: apiKey.key,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
  };

  // The signature covers the query string the store will actually receive.
  const covered: Array<readonly [string, string]> = [...target.searchParams, ...Object.entries(oauth)];
  const signature = hmacSignature(signatureBase(method, target, covered), apiKey.secret);

  for (const [name, value] of Object.entries(oauth)) target.searchParams.set(name, value);
  target.searchParams.set("oauth_signature", signature);
  return {};
}
