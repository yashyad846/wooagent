import { StoreFailure } from "./failures.js";
import type { Settings } from "./settings.js";
import { briefOrder, briefProduct, fullOrder, fullProduct, shapeNote } from "./shape.js";
import { pickMode } from "./signing.js";
import { type Params, StoreClient } from "./transport.js";
import type { WcNote, WcOrder, WcProduct, WcSetting, WcVariant } from "./wc-schema.js";

export interface PageRequest {
  page?: number;
  per_page?: number;
}

export interface OrderQuery extends PageRequest {
  state?: string[];
  from?: string;
  to?: string;
  account_id?: number;
  product_id?: number;
  newest_first?: boolean;
}

export interface CatalogQuery extends PageRequest {
  availability?: string;
  section_id?: number;
  kind?: string;
  sort_by?: "date" | "title" | "price" | "popularity";
  ascending?: boolean;
}

/** WooCommerce caps per_page at 100; scans always ask for the full page. */
const SCAN_PAGE = 100;

/** Fallback when neither the product nor the store defines a low-stock level. */
const FALLBACK_REORDER_AT = 3;

const ascendingWhen = (ascending: boolean) => (ascending ? "asc" : "desc");

/**
 * A bare date means the whole day in the store's timezone. WooCommerce compares
 * `after`/`before` against full timestamps, so an unanchored "2026-04-01" would
 * silently exclude everything placed that day.
 */
function dayBoundary(value: string | undefined, end: boolean): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return `${value}T${end ? "23:59:59" : "00:00:00"}`;
}

function orderParams(query: OrderQuery): Params {
  return {
    page: query.page ?? 1,
    per_page: query.per_page ?? 10,
    status: query.state?.length ? query.state.join(",") : undefined,
    after: dayBoundary(query.from, false),
    before: dayBoundary(query.to, true),
    customer: query.account_id,
    product: query.product_id,
    orderby: "date",
    // newest_first is the agent's word for it; the store wants a sort direction.
    order: ascendingWhen(query.newest_first === false),
  };
}

function catalogParams(query: CatalogQuery): Params {
  return {
    page: query.page ?? 1,
    per_page: query.per_page ?? 10,
    status: "publish",
    stock_status: query.availability,
    category: query.section_id,
    type: query.kind,
    orderby: query.sort_by ?? "date",
    order: ascendingWhen(query.ascending ?? false),
  };
}

interface Listing<T> {
  rows: T[];
  page: number;
  per_page: number;
  matched: number;
  pages: number;
  more_pages: boolean;
}

function listing<T>(rows: T[], params: Params, total?: number, pages?: number): Listing<T> {
  const page = Number(params.page ?? 1);
  const span = pages ?? page;
  return {
    rows,
    page,
    per_page: Number(params.per_page ?? rows.length),
    matched: total ?? rows.length,
    pages: span,
    more_pages: page < span,
  };
}

/**
 * Every read the agent can perform, expressed in this connector's vocabulary
 * rather than WooCommerce's. Nothing here mutates: the client only speaks GET.
 */
export class StoreReader {
  readonly client: StoreClient;

  constructor(private readonly settings: Settings) {
    this.client = new StoreClient(settings);
  }

  private get shaping() {
    return { showContacts: this.settings.showContacts };
  }

  /**
   * Walks a collection page by page, up to `maxPages`, yielding each page and
   * whether it was the last. Keeping the paging in one generator means the two
   * scanning tools share identical stop conditions and page accounting.
   */
  private async *walk<T>(
    path: string,
    params: Params,
    maxPages: number,
  ): AsyncGenerator<{ rows: T[]; exhausted: boolean }> {
    for (let page = 1; page <= maxPages; page++) {
      const fetched = await this.client.get<T[]>(path, { ...params, page, per_page: SCAN_PAGE });
      const rows = fetched.body;
      const exhausted = page >= (fetched.pages ?? page) || rows.length < SCAN_PAGE;
      yield { rows, exhausted };
      if (exhausted) return;
    }
  }

  // ---------------------------------------------------------------- orders

  async orders(query: OrderQuery) {
    const params = orderParams(query);
    const fetched = await this.client.get<WcOrder[]>("/orders", params);
    const rows = fetched.body.map((order) => briefOrder(order, this.shaping));
    return listing(rows, params, fetched.total, fetched.pages);
  }

  async searchOrders(text: string, query: OrderQuery) {
    const params = { ...orderParams(query), search: text };
    const fetched = await this.client.get<WcOrder[]>("/orders", params);
    const rows = fetched.body.map((order) => briefOrder(order, this.shaping));
    return listing(rows, params, fetched.total, fetched.pages);
  }

  async order(orderId: number) {
    const fetched = await this.client.get<WcOrder>(`/orders/${orderId}`);
    return fullOrder(fetched.body, this.shaping);
  }

  async timeline(orderId: number) {
    const fetched = await this.client.get<WcNote[]>(`/orders/${orderId}/notes`);
    const entries = fetched.body.map(shapeNote);
    // Oldest first reads as a story; WooCommerce hands them back newest first.
    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.note_id - b.note_id));
    return { order_id: orderId, entries };
  }

  /**
   * Gateway references (a Razorpay `pay_...`, a Stripe `ch_...`) live in either
   * `transaction_id` or order meta, and WooCommerce indexes neither for search.
   *
   * So: ask search anyway -- some gateways do write the reference somewhere the
   * index reaches, and that path costs one request -- then fall back to a bounded
   * sweep of recent orders. Matching is on value, not meta key, so the connector
   * is not tied to any one plugin's naming.
   */
  async orderByGatewayRef(reference: string, windowDays: number, maxPages: number) {
    const wanted = reference.toLowerCase();
    const isMatch = (order: WcOrder) =>
      (order.transaction_id ?? "").toLowerCase() === wanted ||
      (order.meta_data ?? []).some(
        (field) => typeof field.value === "string" && field.value.toLowerCase() === wanted,
      );

    const answer = (hits: WcOrder[], inspected: number, conclusive: boolean) => ({
      matched: hits.length > 0,
      orders: hits.map((order) => fullOrder(order, this.shaping)),
      orders_inspected: inspected,
      window_days: windowDays,
      /** false means "the sweep ran out of budget", not "no such payment". */
      conclusive,
    });

    const indexed = await this.client.get<WcOrder[]>("/orders", { search: reference, per_page: 20 });
    const quick = indexed.body.filter(isMatch);
    if (quick.length > 0) return answer(quick, indexed.body.length, true);

    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 19);
    let inspected = 0;
    let exhausted = false;

    for await (const page of this.walk<WcOrder>(
      "/orders",
      { modified_after: since, orderby: "date", order: "desc" },
      maxPages,
    )) {
      inspected += page.rows.length;
      const hits = page.rows.filter(isMatch);
      if (hits.length > 0) return answer(hits, inspected, true);
      exhausted = page.exhausted;
    }

    return answer([], inspected, exhausted);
  }

  // --------------------------------------------------------------- catalog

  async catalog(query: CatalogQuery) {
    const params = catalogParams(query);
    const fetched = await this.client.get<WcProduct[]>("/products", params);
    return listing(fetched.body.map(briefProduct), params, fetched.total, fetched.pages);
  }

  async searchCatalog(text: string | undefined, sku: string | undefined, query: CatalogQuery) {
    if (!text && !sku) throw new StoreFailure("bad_parameters", "give either a text query or a sku");
    const params = { ...catalogParams(query), search: text, sku };
    const fetched = await this.client.get<WcProduct[]>("/products", params);
    return listing(fetched.body.map(briefProduct), params, fetched.total, fetched.pages);
  }

  async product(productId: number) {
    const fetched = await this.client.get<WcProduct>(`/products/${productId}`);
    let variants: WcVariant[] = [];
    if (fetched.body.type === "variable") {
      const page = await this.client.get<WcVariant[]>(`/products/${productId}/variations`, {
        per_page: SCAN_PAGE,
      });
      variants = page.body;
    }
    return fullProduct(fetched.body, variants);
  }

  /**
   * The store-wide low-stock level, if the key is allowed to read settings.
   * Many read keys are not, and that is fine -- we degrade to per-product levels.
   */
  private async storeReorderLevel(): Promise<number | undefined> {
    try {
      const fetched = await this.client.get<WcSetting>(
        "/settings/products/woocommerce_notify_low_stock_amount",
      );
      const level = Number(fetched.body.value);
      return Number.isFinite(level) ? level : undefined;
    } catch (thrown) {
      if (
        thrown instanceof StoreFailure &&
        (thrown.code === "scope_too_narrow" || thrown.code === "missing_resource")
      ) {
        return undefined;
      }
      throw thrown;
    }
  }

  /**
   * Sweeps the catalogue for anything out of stock or at/below its reorder level.
   * Precedence for the level: an explicit override, else the product's own
   * `low_stock_amount`, else the store setting, else a conservative default.
   */
  async stockAlerts(override: number | undefined, includeSoldOut: boolean, maxPages: number) {
    const storeLevel = override === undefined ? await this.storeReorderLevel() : undefined;
    const baseline = override ?? storeLevel ?? FALLBACK_REORDER_AT;

    const alerts: Array<ReturnType<typeof briefProduct> & { severity: "sold_out" | "low"; reorder_at: number }> = [];
    let inspected = 0;
    let exhausted = false;

    for await (const page of this.walk<WcProduct>(
      "/products",
      { status: "publish", orderby: "id", order: "asc" },
      maxPages,
    )) {
      inspected += page.rows.length;
      for (const product of page.rows) {
        if (!product.manage_stock || product.stock_quantity === null) continue;
        const level = override ?? product.low_stock_amount ?? baseline;
        const soldOut = product.stock_quantity <= 0;
        if (soldOut && !includeSoldOut) continue;
        if (!soldOut && product.stock_quantity > level) continue;
        alerts.push({
          ...briefProduct(product),
          severity: soldOut ? "sold_out" : "low",
          reorder_at: level,
        });
      }
      exhausted = page.exhausted;
    }

    // Most urgent first, then alphabetical so repeat calls read the same way.
    alerts.sort(
      (a, b) => (a.on_hand ?? 0) - (b.on_hand ?? 0) || a.title.localeCompare(b.title),
    );

    return {
      reorder_level: override ?? `per product, falling back to ${baseline}`,
      alerts,
      products_inspected: inspected,
      conclusive: exhausted,
      caveat:
        "Only products that track stock on the product itself are swept. For a variable product, call product_detail to see each variant's stock.",
    };
  }

  // ------------------------------------------------------------ diagnostics

  /** Cheapest possible proof that the key, the URL and the signing mode all work. */
  async checkLink() {
    const startedAt = Date.now();
    const fetched = await this.client.get<WcOrder[]>("/orders", { per_page: 1 });
    const { budget } = this.settings;
    return {
      reachable: true,
      store_url: this.settings.storeUrl,
      signing: pickMode(this.settings.signing, new URL(this.settings.storeUrl)),
      round_trip_ms: Date.now() - startedAt,
      orders_visible: fetched.total ?? fetched.body.length,
      contacts_veiled: !this.settings.showContacts,
      budget: {
        requests_per_second: budget.rps,
        burst: budget.burst,
        concurrency: budget.concurrency,
        retries: budget.retries,
        timeout_ms: budget.timeoutMs,
      },
      requests_this_session: this.client.counters.calls,
      retries_this_session: this.client.counters.retries,
    };
  }
}
