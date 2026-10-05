import { StoreFailure, classify, fromTransport } from "./failures.js";
import type { Settings } from "./settings.js";
import { authorize } from "./signing.js";
import { Throttle, sleep } from "./throttle.js";

export type Params = Record<string, string | number | boolean | undefined>;

export interface Fetched<T> {
  body: T;
  /** From X-WP-Total / X-WP-TotalPages, when WordPress sends them. */
  total?: number;
  pages?: number;
}

const REST_ROOT = "/wp-json/wc/v3";

/** Worth waiting out; anything else is the store's final answer. */
const WORTH_RETRYING = new Set([429, 502, 503, 504]);

/**
 * We will never block an agent longer than this. If the store asks for more, the
 * tool returns `throttled` with the cooldown so the agent can tell the user
 * instead of the conversation hanging.
 */
const PATIENCE_MS = 30_000;

const FLOOR_MS = 400;

/**
 * Decorrelated jitter: each wait is drawn from [floor, 3x the previous wait].
 * Grows like plain exponential backoff but spreads retries out, so several tools
 * that got throttled together do not all come back at the same instant.
 */
export function nextWait(previous: number): number {
  const ceiling = Math.min(PATIENCE_MS, Math.max(FLOOR_MS, previous * 3));
  return Math.round(FLOOR_MS + Math.random() * (ceiling - FLOOR_MS));
}

/** Retry-After is either a seconds count or an HTTP date. Junk means "no idea". */
export function cooldownFrom(header: string | null): number | undefined {
  if (header === null) return undefined;
  const raw = header.trim();
  if (raw === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw));
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
}

function buildUrl(storeUrl: string, path: string, params: Params): URL {
  const target = new URL(`${storeUrl}${REST_ROOT}${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    target.searchParams.set(name, String(value));
  }
  return target;
}

function countHeader(reply: Response, name: string): number | undefined {
  const raw = reply.headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function decode<T>(reply: Response): Promise<Fetched<T>> {
  const text = await reply.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    throw new StoreFailure(
      "unreadable_reply",
      "the store replied with something other than JSON -- a security plugin may be in front of /wp-json, or pretty permalinks are off",
      { status: reply.status },
    );
  }
  return { body, total: countHeader(reply, "x-wp-total"), pages: countHeader(reply, "x-wp-totalpages") };
}

/**
 * The only thing in the connector that touches the network. Read-only by
 * construction: there is no method here that issues anything but GET.
 */
export class StoreClient {
  readonly counters = { calls: 0, retries: 0 };
  private readonly throttle: Throttle;

  constructor(private readonly settings: Settings) {
    const { rps, burst, concurrency } = settings.budget;
    this.throttle = new Throttle(rps, burst, concurrency);
  }

  async get<T>(path: string, params: Params = {}): Promise<Fetched<T>> {
    const apiKey = this.settings.apiKey;
    if (!apiKey) throw new StoreFailure("store_not_linked", "no API key is configured for this store");

    const { retries, timeoutMs } = this.settings.budget;
    let lastWait = 0;

    for (let attempt = 0; ; attempt++) {
      // Rebuilt per attempt: OAuth signatures carry a nonce and timestamp and
      // cannot be replayed, so a retry needs a freshly signed URL.
      const target = buildUrl(this.settings.storeUrl, path, params);
      const headers = {
        Accept: "application/json",
        ...authorize("GET", target, apiKey, this.settings.signing),
      };

      let reply: Response;
      try {
        this.counters.calls++;
        reply = await this.throttle.submit(() =>
          fetch(target, { headers, signal: AbortSignal.timeout(timeoutMs) }),
        );
      } catch (cause) {
        if (attempt >= retries) throw fromTransport(cause, timeoutMs);
        this.counters.retries++;
        lastWait = nextWait(lastWait);
        await sleep(lastWait);
        continue;
      }

      if (reply.ok) return decode<T>(reply);

      const cooldown = cooldownFrom(reply.headers.get("retry-after"));
      const reported = await reply.json().catch(() => undefined);

      if (WORTH_RETRYING.has(reply.status) && attempt < retries) {
        const waitMs = cooldown !== undefined ? cooldown * 1000 : (lastWait = nextWait(lastWait));
        if (waitMs <= PATIENCE_MS) {
          this.counters.retries++;
          // A 429 is about the store, not this one request: hold the whole queue.
          if (reply.status === 429) this.throttle.holdFor(waitMs);
          await sleep(waitMs);
          continue;
        }
      }

      throw classify(reply.status, reported, cooldown === undefined ? undefined : Math.ceil(cooldown));
    }
  }
}
