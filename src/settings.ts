import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Where the API credential rides on the wire.
 *   header -> HTTP Basic (what WooCommerce wants over TLS)
 *   query  -> OAuth 1.0a one-legged signature (what it wants over plain HTTP)
 *   auto   -> pick by the store URL's scheme
 */
export type SigningMode = "auto" | "header" | "query";

export interface ApiKey {
  key: string;
  secret: string;
}

export interface Budget {
  rps: number;
  burst: number;
  concurrency: number;
  retries: number;
  timeoutMs: number;
}

export interface Settings {
  storeUrl: string;
  apiKey?: ApiKey;
  signing: SigningMode;
  budget: Budget;
  showContacts: boolean;
}

export const KEY_FILE = resolve(process.env.WC_KEY_FILE ?? ".store-key.json");

export interface SavedKey {
  store_url: string;
  consumer_key: string;
  consumer_secret: string;
  key_id: number;
  scope: string;
  linked_at: string;
}

/**
 * Minimal .env reader. Deliberately does not clobber variables that are already
 * set, so a parent process (the test runtime, an MCP client's `env` block) always
 * wins over a stray file in the working directory.
 */
function absorbEnvFile(path = resolve(".env")): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split < 1) continue;
    const name = trimmed.slice(0, split).trim();
    if (name in process.env) continue;
    let value = trimmed.slice(split + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    process.env[name] = value;
  }
}

function readNumber(name: string, fallback: number, floor = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < floor) {
    throw new Error(`${name} must be a number not below ${floor} (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

export function loadSavedKey(path = KEY_FILE): SavedKey | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<SavedKey>;
    if (!saved.consumer_key || !saved.consumer_secret) return undefined;
    return saved as SavedKey;
  } catch {
    throw new Error(`${path} exists but is not readable JSON. Delete it and link the store again.`);
  }
}

const SIGNING_MODES: SigningMode[] = ["auto", "header", "query"];

export function loadSettings(): Settings {
  absorbEnvFile();
  const saved = loadSavedKey();

  const storeUrl = (process.env.WC_STORE_URL || saved?.store_url || "").trim().replace(/\/+$/, "");
  if (!storeUrl) throw new Error("WC_STORE_URL is not set, and no linked store was found. Run `npm run link-store`.");

  const envKey = process.env.WC_CONSUMER_KEY?.trim();
  const envSecret = process.env.WC_CONSUMER_SECRET?.trim();
  const apiKey: ApiKey | undefined =
    envKey && envSecret
      ? { key: envKey, secret: envSecret }
      : saved
        ? { key: saved.consumer_key, secret: saved.consumer_secret }
        : undefined;

  const signing = (process.env.WC_SIGNING ?? "auto") as SigningMode;
  if (!SIGNING_MODES.includes(signing)) throw new Error(`WC_SIGNING must be one of ${SIGNING_MODES.join(", ")}`);

  return {
    storeUrl,
    apiKey,
    signing,
    budget: {
      rps: readNumber("WC_RPS", 5, 0.1),
      burst: readNumber("WC_BURST", 10),
      concurrency: readNumber("WC_CONCURRENCY", 4),
      retries: Math.floor(readNumber("WC_RETRIES", 4, 0)),
      timeoutMs: readNumber("WC_TIMEOUT_MS", 15_000, 100),
    },
    showContacts: process.env.WC_SHOW_CONTACTS === "true",
  };
}
