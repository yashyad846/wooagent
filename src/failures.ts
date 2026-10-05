/**
 * Every failure the agent can see, paired with the advice it should act on.
 * The agent never sees a stack trace or an HTTP status on its own -- it sees a
 * code it can branch on and a sentence telling it what to do next.
 */
export const GUIDANCE = {
  store_not_linked:
    "This store has no API key yet. Ask the merchant to run `npm run link-store`, or to paste a read-only key.",
  key_rejected:
    "The store refused the API key. It was probably revoked -- ask the merchant to link the store again.",
  scope_too_narrow:
    "The key cannot see this resource. A WooCommerce key with 'read' permission is required.",
  missing_resource:
    "No such record. Re-check the identifier, or fall back to one of the search tools.",
  bad_parameters: "The store rejected these filters. Loosen or correct them before retrying.",
  throttled: "The store is throttling. Pause, then retry with narrower filters -- avoid full scans.",
  store_offline: "The store is temporarily unreachable. Say so plainly and suggest retrying later.",
  store_too_slow:
    "The store did not answer in time. Ask for less: a smaller per_page, a tighter date window.",
  unreadable_reply:
    "The store sent something that is not the expected JSON. Do not guess -- report that the data could not be read.",
} as const;

export type FailureCode = keyof typeof GUIDANCE;

interface FailureContext {
  status?: number;
  cooldownSeconds?: number;
  storeCode?: string;
}

export class StoreFailure extends Error {
  override readonly name = "StoreFailure";

  constructor(
    readonly code: FailureCode,
    message: string,
    readonly context: FailureContext = {},
  ) {
    super(message);
  }

  /** The exact JSON body a tool returns when it fails. */
  forAgent() {
    const { cooldownSeconds } = this.context;
    return {
      failed: this.code,
      detail: this.message,
      next_step: GUIDANCE[this.code],
      ...(cooldownSeconds !== undefined ? { retry_after_seconds: cooldownSeconds } : {}),
    };
  }
}

/** WooCommerce speaks in WordPress REST statuses; this is the translation table. */
const BY_STATUS = new Map<number, FailureCode>([
  [400, "bad_parameters"],
  [401, "key_rejected"],
  [403, "scope_too_narrow"],
  [404, "missing_resource"],
  [429, "throttled"],
]);

const TAGS = /<[^>]*>/g;

export function plainText(value: string): string {
  return value.replace(TAGS, "").replace(/\s+/g, " ").trim();
}

export function classify(status: number, body: unknown, cooldownSeconds?: number): StoreFailure {
  const reported = (body && typeof body === "object" ? body : {}) as { code?: string; message?: string };
  const detail = reported.message ? plainText(reported.message) : `the store answered HTTP ${status}`;
  const code: FailureCode = BY_STATUS.get(status) ?? (status >= 500 ? "store_offline" : "unreadable_reply");
  return new StoreFailure(code, detail, { status, storeCode: reported.code, cooldownSeconds });
}

/** fetch() rejected: either the timeout signal fired, or the socket never opened. */
export function fromTransport(cause: unknown, timeoutMs: number): StoreFailure {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new StoreFailure("store_too_slow", `no response within ${timeoutMs}ms`);
  }
  const why = cause instanceof Error ? cause.message : String(cause);
  return new StoreFailure("store_offline", `could not reach the store: ${why}`);
}

/** Anything thrown that was not already a StoreFailure still has to reach the agent as one. */
export function asFailure(thrown: unknown): StoreFailure {
  if (thrown instanceof StoreFailure) return thrown;
  return new StoreFailure("unreadable_reply", thrown instanceof Error ? thrown.message : String(thrown));
}
