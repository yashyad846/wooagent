import type { WcNote, WcOrder, WcProduct, WcVariant } from "../src/wc-schema.js";

/**
 * Seed data for a fictional store: Clayhouse Ceramics, a small pottery studio in
 * Puducherry that sells through WooCommerce with the Razorpay plugin.
 *
 * Everyone, every email, every phone number and every payment reference here is
 * invented. Nothing in this file corresponds to a real person or a real payment.
 *
 * Two layers, on purpose:
 *   - the awkward cases are written out by hand, because those are what the
 *     connector exists to answer and they need to be exactly wrong in the right
 *     way (paid but still pending, a timed-out authorisation, a part refund);
 *   - the rest is generated from a fixed seed, so there is enough volume for
 *     paging, sorting and sweep limits to mean something.
 */

export const STORE = {
  name: "Clayhouse Ceramics",
  currency: "INR",
  domain: "clayhouse.example",
  freeShippingAbove: 1500,
  flatShipping: 90,
} as const;

/** xorshift32 -- small, deterministic, and good enough to lay out fake orders. */
function stream(seed: number): () => number {
  let state = seed | 0 || 0x5bf03635;
  return () => {
    state ^= state << 13;
    state |= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 0) / 4_294_967_296;
  };
}

const next = stream(0x1f2e3d4c);
const oneOf = <T>(choices: readonly T[]): T => choices[Math.floor(next() * choices.length)];
const between = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
const stamp = (at: Date) => at.toISOString().slice(0, 19);

/** Gateway references are 14 base-58-ish characters, like Razorpay's. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const gatewayRef = (prefix: string) =>
  `${prefix}_${Array.from({ length: 14 }, () => oneOf([...ALPHABET])).join("")}`;

// ----------------------------------------------------------------- catalogue

export const SECTIONS = [
  { id: 21, name: "Mugs & Cups" },
  { id: 22, name: "Plates & Bowls" },
  { id: 23, name: "Vases & Planters" },
  { id: 24, name: "Studio Tools" },
] as const;

/** [title, section, rupees, on hand (null = stock untracked), own reorder level] */
type ProductSpec = [string, number, number, number | null, number | null];

const CATALOGUE: ProductSpec[] = [
  ["Terracotta Cutting Chai Glasses, set of 4", 21, 480, 26, null],
  ["Speckled Stoneware Mug, 300ml", 21, 620, 4, 6],
  ["Wheel-thrown Espresso Cup", 21, 390, 0, null],
  ["Indigo Glaze Tea Bowl", 21, 540, 11, null],
  ["Matte Black Mug, 350ml", 21, 690, 2, null],
  ["Rimmed Dinner Plate, 26cm", 22, 880, 18, null],
  ["Ash Glaze Serving Bowl", 22, 1340, 1, 4],
  ["Quarter Plates, set of 2", 22, 760, 0, null],
  ["Stoneware Ramen Bowl", 22, 950, 7, null],
  ["Pickle Jar with Wooden Lid", 22, 1120, 33, null],
  ["Bud Vase, Celadon", 23, 740, 9, null],
  ["Tall Cylinder Vase, 30cm", 23, 1890, 3, 5],
  ["Self-watering Planter, 6in", 23, 1250, 0, null],
  ["Hanging Planter, Unglazed", 23, 980, 14, null],
  ["Bonsai Tray, 20cm", 23, 860, 6, null],
  ["Boxwood Rib Set", 24, 450, 41, null],
  ["Wire Clay Cutter", 24, 220, 58, null],
  ["Banding Wheel, 8in", 24, 2650, 2, 3],
  ["Loop Trimming Tool", 24, 310, null, null],
  ["Glaze Test Tile Pack of 25", 24, 390, 12, null],
];

const slugify = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const products: WcProduct[] = CATALOGUE.map(([title, section, rupees, onHand, reorderAt], index) => {
  const id = 3100 + index * 3;
  const tracked = onHand !== null;
  const onOffer = index % 6 === 2;
  // One product is kept unpublished so the catalogue tools can be shown ignoring drafts.
  const published = title !== "Glaze Test Tile Pack of 25";
  return {
    id,
    name: title,
    slug: slugify(title),
    sku: `CH${section}-${String(index + 1).padStart(3, "0")}`,
    type: "simple",
    status: published ? "publish" : "draft",
    permalink: `https://${STORE.domain}/shop/${slugify(title)}`,
    price: String(onOffer ? Math.round(rupees * 0.8) : rupees),
    regular_price: String(rupees),
    sale_price: onOffer ? String(Math.round(rupees * 0.8)) : "",
    on_sale: onOffer,
    manage_stock: tracked,
    stock_quantity: onHand,
    stock_status: !tracked
      ? "instock"
      : onHand === 0
        ? title === "Quarter Plates, set of 2"
          ? "onbackorder"
          : "outofstock"
        : "instock",
    low_stock_amount: reorderAt,
    backorders: title === "Quarter Plates, set of 2" ? "notify" : "no",
    short_description: `<p>${title}. Thrown and glazed by hand at the Clayhouse studio, so no two are identical.</p>`,
    categories: SECTIONS.filter((s) => s.id === section).map((s) => ({ id: s.id, name: s.name })),
    date_modified: "2026-09-27T11:20:00",
  } satisfies WcProduct;
});

export const APRON_ID = 3180;

export const variants = new Map<number, WcVariant[]>();

products.push({
  id: APRON_ID,
  name: "Clayhouse Studio Apron",
  slug: "clayhouse-studio-apron",
  sku: "CH-APRON",
  type: "variable",
  status: "publish",
  permalink: `https://${STORE.domain}/shop/clayhouse-studio-apron`,
  price: "1150",
  regular_price: "",
  sale_price: "",
  on_sale: false,
  // Stock lives on the variations, not here -- the classic reason a sweep of
  // products alone cannot answer "is it in medium?".
  manage_stock: false,
  stock_quantity: null,
  stock_status: "instock",
  low_stock_amount: null,
  backorders: "no",
  short_description: "<p>Heavy cotton canvas, double-stitched pockets.</p>",
  categories: [{ id: 24, name: "Studio Tools" }],
  variations: [APRON_ID + 1, APRON_ID + 2, APRON_ID + 3],
  date_modified: "2026-09-25T16:05:00",
});

variants.set(APRON_ID, [
  {
    id: APRON_ID + 1,
    sku: "CH-APRON-S",
    price: "1150",
    manage_stock: true,
    stock_quantity: 9,
    stock_status: "instock",
    attributes: [{ name: "Size", option: "S" }],
  },
  {
    id: APRON_ID + 2,
    sku: "CH-APRON-M",
    price: "1150",
    manage_stock: true,
    stock_quantity: 1,
    stock_status: "instock",
    attributes: [{ name: "Size", option: "M" }],
  },
  {
    id: APRON_ID + 3,
    sku: "CH-APRON-L",
    price: "1250",
    manage_stock: true,
    stock_quantity: 0,
    stock_status: "outofstock",
    attributes: [{ name: "Size", option: "L" }],
  },
]);

export const storeSettings: Record<string, string> = {
  woocommerce_notify_low_stock_amount: "4",
  woocommerce_currency: STORE.currency,
};

// ------------------------------------------------------------------- buyers

const GIVEN = [
  "Lakshmi", "Faizal", "Ananya", "Joseph", "Revathi", "Imran", "Sandhya", "Nikhil",
  "Benedicta", "Yusuf", "Kavya", "Thomas", "Preethi", "Arun", "Shalini", "Gautam",
];
const FAMILY = [
  "Subramanian", "Pillai", "Fernandes", "Raghavan", "Qureshi", "Varma", "Dsouza",
  "Krishnan", "Bhat", "Antony", "Shetty", "Narayanan",
];
const WHERE: Array<[string, string, string]> = [
  ["Puducherry", "PY", "605001"],
  ["Chennai", "TN", "600018"],
  ["Coimbatore", "TN", "641002"],
  ["Kochi", "KL", "682016"],
  ["Bengaluru", "KA", "560095"],
  ["Hyderabad", "TG", "500034"],
  ["Mumbai", "MH", "400050"],
  ["Ahmedabad", "GJ", "380009"],
];
const STREETS = [
  "Rue Suffren", "Mission Street", "Bharathi Park Road", "Lal Bahadur Shastri Road",
  "Hosur Road", "Fort Kochi Road", "Hill Road",
];

export interface Buyer {
  accountId: number;
  given: string;
  family: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  postcode: string;
  street: string;
}

export const buyers: Buyer[] = Array.from({ length: 20 }, (_, index) => {
  const given = GIVEN[index % GIVEN.length];
  const family = oneOf(FAMILY);
  const [city, state, postcode] = oneOf(WHERE);
  return {
    // The last few are guest checkouts: WooCommerce reports customer_id 0.
    accountId: index < 14 ? 7001 + index : 0,
    given,
    family,
    email: `${given.toLowerCase()}.${family.toLowerCase()}${index}@example.com`,
    phone: `+91 9${between(100000000, 899999999)}`,
    city,
    state,
    postcode,
    street: `${between(2, 180)}, ${oneOf(STREETS)}`,
  };
});

// ------------------------------------------------------------------- orders

const sellable = products.filter((p) => p.type === "simple" && p.status === "publish");

const clock = new Date();
clock.setUTCSeconds(0, 0);

interface OrderSpec {
  state: string;
  hoursAgo: number;
  buyer: Buyer;
  basket: Array<[WcProduct, number]>;
  gateway: "razorpay" | "cod";
  couponPercent?: number;
  /** Money reached the gateway but the order never moved off pending. */
  captureStranded?: boolean;
  /** Fraction of the order value that came back, for partial refunds. */
  refundShare?: number;
  buyerNote?: string;
}

const PAID_STATES = new Set(["processing", "completed", "refunded"]);

const orderList: WcOrder[] = [];
const noteIndex = new Map<number, WcNote[]>();
let nextId = 2101;

function compose(spec: OrderSpec): WcOrder {
  const id = nextId++;
  const placedAt = new Date(clock.getTime() - spec.hoursAgo * 3_600_000);
  const touchedAt = new Date(placedAt.getTime() + between(1, 40) * 3_600_000);

  const lines = spec.basket.map(([product, quantity], slot) => {
    const unit = Number(product.price);
    return {
      id: id * 10 + slot,
      name: product.name,
      product_id: product.id,
      variation_id: 0,
      quantity,
      sku: product.sku,
      price: unit,
      subtotal: (unit * quantity).toFixed(2),
      total: (unit * quantity).toFixed(2),
    };
  });

  const goods = lines.reduce((sum, line) => sum + Number(line.total), 0);
  const discount = spec.couponPercent ? Math.round((goods * spec.couponPercent) / 100) : 0;
  const shipping = goods - discount >= STORE.freeShippingAbove ? 0 : STORE.flatShipping;
  const charged = goods - discount + shipping;

  const viaGateway = spec.gateway === "razorpay";
  const settled = PAID_STATES.has(spec.state);
  const paymentRef = viaGateway && (settled || spec.state === "failed" || spec.captureStranded)
    ? gatewayRef("pay")
    : "";
  const gatewayOrderRef = viaGateway ? gatewayRef("order") : "";

  const refundAmount =
    spec.state === "refunded" ? charged * (spec.refundShare ?? 1) : 0;

  const meta = viaGateway
    ? [
        { id: id * 9, key: "_razorpay_order_id", value: gatewayOrderRef },
        // Deliberately only present when the capture stranded: this is the record
        // that proves the customer paid while the order says otherwise.
        ...(spec.captureStranded ? [{ id: id * 9 + 1, key: "_razorpay_payment_id", value: paymentRef }] : []),
      ]
    : [];

  const order: WcOrder = {
    id,
    number: String(id),
    status: spec.state,
    currency: STORE.currency,
    date_created: stamp(placedAt),
    date_modified: stamp(touchedAt),
    date_paid: settled ? stamp(placedAt) : null,
    date_completed: spec.state === "completed" ? stamp(touchedAt) : null,
    total: charged.toFixed(2),
    // GST-inclusive pricing, so tax is carved out of the total rather than added.
    total_tax: (charged - charged / 1.12).toFixed(2),
    shipping_total: shipping.toFixed(2),
    discount_total: discount.toFixed(2),
    payment_method: viaGateway ? "razorpay" : "cod",
    payment_method_title: viaGateway ? "Card / UPI / Netbanking (Razorpay)" : "Cash on delivery",
    // Pending orders have nothing to show here even when money moved -- that gap
    // is exactly what order_by_gateway_ref exists to close.
    transaction_id: settled ? paymentRef : "",
    customer_id: spec.buyer.accountId,
    customer_note: spec.buyerNote ?? "",
    billing: {
      first_name: spec.buyer.given,
      last_name: spec.buyer.family,
      address_1: spec.buyer.street,
      city: spec.buyer.city,
      state: spec.buyer.state,
      postcode: spec.buyer.postcode,
      country: "IN",
      email: spec.buyer.email,
      phone: spec.buyer.phone,
    },
    shipping: {
      first_name: spec.buyer.given,
      last_name: spec.buyer.family,
      address_1: spec.buyer.street,
      city: spec.buyer.city,
      state: spec.buyer.state,
      postcode: spec.buyer.postcode,
      country: "IN",
    },
    line_items: lines,
    shipping_lines: [
      { method_title: shipping === 0 ? "Free shipping" : "Standard delivery", total: shipping.toFixed(2) },
    ],
    coupon_lines: discount ? [{ code: "STUDIO10", discount: discount.toFixed(2) }] : [],
    refunds: refundAmount
      ? [
          {
            id: id * 100,
            reason: spec.refundShare && spec.refundShare < 1 ? "One mug arrived chipped" : "Returned, unopened",
            total: `-${refundAmount.toFixed(2)}`,
          },
        ]
      : [],
    meta_data: meta,
  };

  noteIndex.set(id, writeTimeline(order, placedAt, { paymentRef, gatewayOrderRef, stranded: Boolean(spec.captureStranded) }));
  return order;
}

/** The note trail a real gateway and real staff would have left behind. */
function writeTimeline(
  order: WcOrder,
  placedAt: Date,
  refs: { paymentRef: string; gatewayOrderRef: string; stranded: boolean },
): WcNote[] {
  const trail: WcNote[] = [];
  const write = (body: string, afterMinutes: number, author = "Clayhouse", toCustomer = false) => {
    trail.push({
      id: order.id * 10 + trail.length,
      author,
      date_created: stamp(new Date(placedAt.getTime() + afterMinutes * 60_000)),
      note: body,
      customer_note: toCustomer,
    });
  };

  if (refs.gatewayOrderRef) write(`Razorpay order created: ${refs.gatewayOrderRef}`, 0);

  switch (order.status) {
    case "failed":
      write(
        `Razorpay reported the payment as failed${refs.paymentRef ? ` (${refs.paymentRef})` : ""}: authorisation was not completed in time. Order status changed from Pending payment to Failed.`,
        4,
      );
      break;
    case "pending":
      if (refs.stranded) {
        write(
          `Razorpay webhook received: payment ${refs.paymentRef} was captured, but the shopper never returned to the store so the order was not advanced.`,
          6,
        );
      } else {
        write("Awaiting payment. No gateway response yet.", 2);
      }
      break;
    case "processing":
      write(`Payment received via Razorpay. Reference: ${refs.paymentRef}`, 3);
      write("Order status changed from Pending payment to Processing.", 4);
      break;
    case "completed":
      if (refs.paymentRef) write(`Payment received via Razorpay. Reference: ${refs.paymentRef}`, 3);
      write("Order status changed from Pending payment to Processing.", 5);
      write("Packed and handed to India Post. Tracking shared by email.", 26 * 60, "Revathi (studio)", true);
      write("Order status changed from Processing to Completed.", 27 * 60);
      break;
    case "refunded":
      write(`Payment received via Razorpay. Reference: ${refs.paymentRef}`, 3);
      write(
        `Refund of INR ${Math.abs(Number(order.refunds?.[0]?.total ?? 0)).toFixed(2)} issued -- ${order.refunds?.[0]?.reason ?? "returned"}.`,
        60 * 50,
        "Revathi (studio)",
      );
      break;
    case "on-hold":
      write(
        "Cash on delivery order held for a confirmation call. Order status changed from Pending payment to On hold.",
        12,
        "Gautam (studio)",
      );
      break;
    case "cancelled":
      write("Shopper asked to cancel over WhatsApp before dispatch.", 40, "Gautam (studio)");
      break;
    default:
      break;
  }

  return trail;
}

const item = (title: string, quantity: number): [WcProduct, number] => {
  const found = products.find((p) => p.name === title);
  if (!found) throw new Error(`fixture error: no product titled ${title}`);
  return [found, quantity];
};

/**
 * The hand-written cases. These are the support conversations the connector is
 * meant to resolve, so they are pinned rather than generated.
 */
const SCRIPTED: OrderSpec[] = [
  {
    // The headline case: money captured, order still says pending.
    state: "pending",
    hoursAgo: 5,
    buyer: buyers[2],
    basket: [item("Ash Glaze Serving Bowl", 1), item("Indigo Glaze Tea Bowl", 2)],
    gateway: "razorpay",
    captureStranded: true,
  },
  {
    state: "failed",
    hoursAgo: 20,
    buyer: buyers[5],
    basket: [item("Banding Wheel, 8in", 1)],
    gateway: "razorpay",
  },
  {
    state: "pending",
    hoursAgo: 2,
    buyer: buyers[17],
    basket: [item("Wire Clay Cutter", 2)],
    gateway: "razorpay",
  },
  {
    state: "completed",
    hoursAgo: 90,
    buyer: buyers[0],
    basket: [item("Rimmed Dinner Plate, 26cm", 4), item("Pickle Jar with Wooden Lid", 1)],
    gateway: "razorpay",
    couponPercent: 10,
    buyerNote: "Please pack the plates with extra padding.",
  },
  {
    state: "refunded",
    hoursAgo: 150,
    buyer: buyers[8],
    basket: [item("Speckled Stoneware Mug, 300ml", 2)],
    gateway: "razorpay",
    refundShare: 0.5,
  },
  {
    state: "on-hold",
    hoursAgo: 30,
    buyer: buyers[11],
    basket: [item("Tall Cylinder Vase, 30cm", 1)],
    gateway: "cod",
  },
  {
    state: "cancelled",
    hoursAgo: 64,
    buyer: buyers[13],
    basket: [item("Hanging Planter, Unglazed", 3)],
    gateway: "cod",
  },
  {
    state: "processing",
    hoursAgo: 11,
    buyer: buyers[4],
    basket: [item("Bud Vase, Celadon", 1), item("Bonsai Tray, 20cm", 1)],
    gateway: "razorpay",
  },
  {
    state: "completed",
    hoursAgo: 210,
    buyer: buyers[15],
    basket: [item("Boxwood Rib Set", 1)],
    gateway: "cod",
  },
];

/** Roughly what a small studio's order mix looks like over a couple of months. */
const MIX: Array<[string, number]> = [
  ["completed", 44],
  ["processing", 19],
  ["failed", 9],
  ["pending", 8],
  ["on-hold", 7],
  ["cancelled", 7],
  ["refunded", 6],
];

function rollState(): string {
  let point = next() * MIX.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [state, weight] of MIX) {
    point -= weight;
    if (point < 0) return state;
  }
  return "completed";
}

const FILLER_COUNT = 61;

for (const spec of SCRIPTED) orderList.push(compose(spec));

for (let n = 0; n < FILLER_COUNT; n++) {
  const state = rollState();
  const gateway: "razorpay" | "cod" = next() < 0.78 ? "razorpay" : "cod";
  orderList.push(
    compose({
      state,
      // Spread back over about ten weeks, newest last.
      hoursAgo: 6 + (FILLER_COUNT - n) * between(20, 30),
      buyer: oneOf(buyers),
      basket: Array.from({ length: between(1, 3) }, () => {
        const product = oneOf(sellable);
        return [product, between(1, 3)] as [WcProduct, number];
      }),
      gateway,
      couponPercent: next() < 0.12 ? 10 : undefined,
      captureStranded: state === "pending" && gateway === "razorpay" && next() < 0.3,
      buyerNote: next() < 0.08 ? "Gift -- please leave out the invoice." : undefined,
    }),
  );
}

/** Newest first, which is how the store returns them and how support reads them. */
orderList.sort((a, b) => (a.date_created < b.date_created ? 1 : a.date_created > b.date_created ? -1 : b.id - a.id));

export const orders: WcOrder[] = orderList;
export const notes: Map<number, WcNote[]> = noteIndex;

/** Handles for the tests and the walkthrough, so neither has to go hunting. */
export const SPOTLIGHT = {
  strandedPayment: orders.find((o) => o.status === "pending" && o.meta_data?.some((m) => m.key === "_razorpay_payment_id"))!,
  failedPayment: orders.find((o) => o.status === "failed" && o.payment_method === "razorpay")!,
  withCoupon: orders.find((o) => (o.coupon_lines?.length ?? 0) > 0)!,
  partlyRefunded: orders.find((o) => o.status === "refunded" && Number(o.refunds?.[0]?.total ?? 0) !== -Number(o.total))!,
  settled: orders.find((o) => o.status === "completed" && o.transaction_id?.startsWith("pay_"))!,
};
