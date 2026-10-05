import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { KEY_FILE, type SavedKey } from "./settings.js";

/**
 * WooCommerce's /wc-auth/v1/authorize flow: the merchant approves the app in
 * their own admin session and WooCommerce mints a key and POSTs it back. It is
 * the closest thing WooCommerce has to OAuth, and it means the merchant never
 * pastes a secret into anything.
 */

const DEFAULT_PORT = 4466;
const DEFAULT_APP_NAME = "Storefront Reader";
const GRANT_PATH = "/grant";
const DONE_PATH = "/linked";
const BODY_CAP = 16 * 1024;

export interface LinkOptions {
  storeUrl: string;
  port?: number;
  /** A public HTTPS URL that forwards to this machine. Live stores refuse plain HTTP. */
  publicCallback?: string;
  appName?: string;
  waitMs?: number;
  keyFile?: string;
  /** Hook for tests and for printing the URL; defaults to console.log. */
  announce?: (authorizeUrl: string) => void;
}

/** Exactly the payload WooCommerce POSTs to the callback. */
interface Grant {
  key_id: number;
  user_id: string;
  consumer_key: string;
  consumer_secret: string;
  key_permissions: string;
}

export function authorizeUrl(
  storeUrl: string,
  nonce: string,
  callback: string,
  returnTo: string,
  appName: string,
): string {
  const url = new URL(`${storeUrl.replace(/\/+$/, "")}/wc-auth/v1/authorize`);
  url.searchParams.set("app_name", appName);
  // Never ask for more than read: an over-scoped key is a liability even unused.
  url.searchParams.set("scope", "read");
  url.searchParams.set("user_id", nonce);
  url.searchParams.set("return_url", returnTo);
  url.searchParams.set("callback_url", callback);
  return url.toString();
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > BODY_CAP) throw new Error("callback body too large");
  }
  return body;
}

/** Constant-time so the nonce cannot be probed a character at a time. */
function sameNonce(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

type Verdict = { ok: true; key: SavedKey } | { ok: false; status: number; why: string; fatal: boolean };

/**
 * Two things have to be true before a key is worth keeping: it answers the
 * challenge we sent (so it is our flow, not a forged POST), and it is read-only
 * (so an admin who clicked the wrong button does not hand us write access).
 */
export function judgeGrant(grant: Partial<Grant>, nonce: string, storeUrl: string): Verdict {
  if (typeof grant.user_id !== "string" || !sameNonce(grant.user_id, nonce)) {
    return { ok: false, status: 400, why: "challenge mismatch", fatal: false };
  }
  if (!grant.consumer_key || !grant.consumer_secret) {
    return { ok: false, status: 400, why: "no key in callback", fatal: false };
  }
  if (grant.key_permissions !== "read") {
    return {
      ok: false,
      status: 400,
      why: "read-only key required",
      fatal: true,
    };
  }
  return {
    ok: true,
    key: {
      store_url: storeUrl.replace(/\/+$/, ""),
      consumer_key: grant.consumer_key,
      consumer_secret: grant.consumer_secret,
      key_id: grant.key_id ?? 0,
      scope: grant.key_permissions,
      linked_at: new Date().toISOString(),
    },
  };
}

const htmlPage = (body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Store linked</title>` +
  `<body style="font:16px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">${body}</body>`;

export function linkStore(options: LinkOptions): Promise<SavedKey> {
  const port = options.port ?? DEFAULT_PORT;
  const nonce = randomBytes(16).toString("hex");
  const localBase = `http://localhost:${port}`;
  const callback = options.publicCallback ?? `${localBase}${GRANT_PATH}`;
  const keyFile = options.keyFile ?? KEY_FILE;
  const url = authorizeUrl(
    options.storeUrl,
    nonce,
    callback,
    `${localBase}${DONE_PATH}`,
    options.appName ?? DEFAULT_APP_NAME,
  );

  return new Promise<SavedKey>((settle, fail) => {
    let settled = false;
    const finish = (error?: Error, key?: SavedKey) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // Let the in-flight response flush before tearing the listener down.
      setTimeout(() => listener.close(), 250);
      if (error) fail(error);
      else settle(key!);
    };

    async function onGrant(req: IncomingMessage, res: ServerResponse) {
      let parsed: Partial<Grant>;
      try {
        parsed = JSON.parse(await readBody(req)) as Partial<Grant>;
      } catch {
        res.writeHead(400).end("unreadable callback");
        return;
      }

      const verdict = judgeGrant(parsed, nonce, options.storeUrl);
      if (!verdict.ok) {
        res.writeHead(verdict.status).end(verdict.why);
        // A challenge mismatch is someone else's stray POST: keep waiting for
        // the real one. An over-scoped key is the merchant's own grant, and
        // retrying will not change it, so stop and tell them.
        if (verdict.fatal) {
          finish(
            new Error(
              `the store granted '${parsed.key_permissions}' access, but this connector only accepts read-only keys -- revoke that key in WooCommerce and try again`,
            ),
          );
        }
        return;
      }

      // 0600: the secret must not be readable by other accounts on the machine.
      writeFileSync(keyFile, `${JSON.stringify(verdict.key, null, 2)}\n`, { mode: 0o600 });
      res.writeHead(200).end("ok");
      finish(undefined, verdict.key);
    }

    const listener = createServer((req, res) => {
      const path = new URL(req.url ?? "/", localBase).pathname;
      if (req.method === "POST" && path === GRANT_PATH) {
        void onGrant(req, res);
        return;
      }
      if (req.method === "GET" && path === DONE_PATH) {
        res
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(htmlPage("<h2>Store linked.</h2><p>You can close this tab.</p>"));
        return;
      }
      res.writeHead(404).end();
    });

    const deadline = setTimeout(
      () => finish(new Error("gave up waiting for the merchant to approve access")),
      options.waitMs ?? 5 * 60_000,
    );

    listener.on("error", (cause) => finish(cause));
    listener.listen(port, () => (options.announce ?? console.log)(url));
  });
}

async function cli(): Promise<void> {
  const { values } = parseArgs({
    options: {
      store: { type: "string" },
      port: { type: "string", default: String(DEFAULT_PORT) },
      callback: { type: "string" },
    },
  });

  const storeUrl = values.store ?? process.env.WC_STORE_URL;
  if (!storeUrl) {
    console.error(
      "usage: npm run link-store -- --store https://shop.example.com [--callback https://<tunnel>/grant]",
    );
    process.exit(1);
  }

  if (storeUrl.startsWith("https://") && !values.callback) {
    console.warn(
      `Heads up: WooCommerce only POSTs keys to an HTTPS callback. For a live store, expose port ${values.port} ` +
        "through a tunnel and pass --callback https://<tunnel>/grant\n",
    );
  }

  const key = await linkStore({
    storeUrl,
    port: Number(values.port),
    publicCallback: values.callback,
    announce: (url) =>
      console.log(
        `Open this as a store admin and click Approve:\n\n  ${url}\n\nWaiting for approval...`,
      ),
  });

  console.log(
    `\nLinked ${key.store_url} with a read-only key (key_id ${key.key_id}). Saved to ${KEY_FILE}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((thrown: unknown) => {
    console.error(thrown instanceof Error ? thrown.message : String(thrown));
    process.exit(1);
  });
}
