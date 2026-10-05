import type {
  WcAddress,
  WcNote,
  WcOrder,
  WcProduct,
  WcVariant,
} from "./wc-schema.js";

/**
 * Turns WooCommerce payloads into the compact JSON the agent reads.
 *
 * Two jobs, both about the model rather than the merchant:
 *   1. Budget. A raw WooCommerce order is ~4 KB of mostly empty fields; the model
 *      pays for every token of it. Lists carry a brief, details carry the rest.
 *   2. Privacy. Contact details are reduced to the minimum support needs to
 *      confirm "yes, that is your order" and nothing more.
 */

export interface ShapeOptions {
  /** When false (the default) contact details are reduced before the model sees them. */
  showContacts: boolean;
}

const PREVIEW_LINES = 4;
const BLURB_CHARS = 320;
const NOTE_CHARS = 900;

/** meera.iyer@example.com -> m***r@example.com. Enough to recognise, not to contact. */
export function veilEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.length >= 3 ? `${local[0]}***${local.at(-1)}` : "***";
  return `${shown}@${domain}`;
}

/** +91 98765 43210 -> ***43210's last four only. */
export function veilPhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D+/g, "");
  return digits.length < 4 ? "***" : `***${digits.slice(-4)}`;
}

function flatten(html?: string, cap = BLURB_CHARS): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > cap ? `${text.slice(0, cap).trimEnd()}...` : text;
}

const blank = (value?: string) => (value && value.trim() !== "" ? value : undefined);

function personName(where: WcAddress): string | undefined {
  return [where.first_name, where.last_name].filter(Boolean).join(" ") || undefined;
}

/**
 * Region is always safe to show -- support needs it to tell two customers apart
 * and to answer delivery questions. The street lines are the part we withhold.
 */
function place(where: WcAddress, options: ShapeOptions) {
  const region = {
    city: blank(where.city),
    state: blank(where.state),
    postcode: blank(where.postcode),
    country: blank(where.country),
  };
  if (!options.showContacts) return region;
  return { street: [blank(where.address_1), blank(where.address_2)].filter(Boolean).join(", ") || undefined, ...region };
}

function buyer(order: WcOrder, options: ShapeOptions) {
  const { billing } = order;
  return {
    name: personName(billing),
    email: options.showContacts ? blank(billing.email) : veilEmail(billing.email),
    phone: options.showContacts ? blank(billing.phone) : veilPhone(billing.phone),
    account_id: order.customer_id || null,
  };
}

const money = (value: number) => value.toFixed(2);

export function briefOrder(order: WcOrder, options: ShapeOptions) {
  return {
    order_id: order.id,
    reference: order.number,
    state: order.status,
    placed_at: order.date_created,
    paid_at: order.date_paid,
    amount: order.total,
    currency: order.currency,
    gateway: blank(order.payment_method_title) ?? blank(order.payment_method) ?? null,
    gateway_ref: blank(order.transaction_id) ?? null,
    buyer: buyer(order, options),
    units: order.line_items.reduce((sum, line) => sum + line.quantity, 0),
    preview: order.line_items.slice(0, PREVIEW_LINES).map((line) => `${line.name} x${line.quantity}`),
  };
}

export function fullOrder(order: WcOrder, options: ShapeOptions) {
  const { preview, ...brief } = briefOrder(order, options);
  const refunds = order.refunds ?? [];
  const refunded = refunds.reduce((sum, refund) => sum + Math.abs(Number(refund.total)), 0);

  return {
    ...brief,
    updated_at: order.date_modified ?? null,
    completed_at: order.date_completed,
    lines: order.line_items.map((line) => ({
      title: line.name,
      sku: blank(line.sku) ?? null,
      product_id: line.product_id,
      variant_id: line.variation_id || null,
      quantity: line.quantity,
      unit_price: String(line.price),
      line_total: line.total,
    })),
    money: {
      discount: order.discount_total ?? "0.00",
      shipping: order.shipping_total ?? "0.00",
      tax: order.total_tax ?? "0.00",
      charged: order.total,
      refunded: money(refunded),
    },
    coupons: (order.coupon_lines ?? []).map((coupon) => coupon.code),
    delivery: (order.shipping_lines ?? []).map((line) => line.method_title).join(", ") || null,
    bill_to: place(order.billing, options),
    ship_to: place(order.shipping, options),
    buyer_note: blank(order.customer_note) ?? null,
    refunds: refunds.map((refund) => ({
      amount: money(Math.abs(Number(refund.total))),
      reason: blank(refund.reason) ?? null,
    })),
  };
}

export function shapeNote(note: WcNote) {
  return {
    note_id: note.id,
    at: note.date_created,
    by: note.author,
    audience: note.customer_note ? "customer" : "internal",
    body: flatten(note.note, NOTE_CHARS),
  };
}

export function briefProduct(product: WcProduct) {
  const discounted =
    product.on_sale ?? (product.sale_price !== "" && product.sale_price !== product.regular_price);
  return {
    product_id: product.id,
    title: product.name,
    sku: blank(product.sku) ?? null,
    kind: product.type,
    state: product.status,
    price: product.price,
    discounted,
    availability: product.stock_status,
    on_hand: product.manage_stock ? product.stock_quantity : null,
    tracked: product.manage_stock,
    sections: (product.categories ?? []).map((term) => term.name),
  };
}

export function fullProduct(product: WcProduct, variants: WcVariant[] = []) {
  return {
    ...briefProduct(product),
    list_price: blank(product.regular_price) ?? null,
    offer_price: blank(product.sale_price) ?? null,
    reorder_at: product.low_stock_amount ?? null,
    backorder_policy: product.backorders ?? null,
    blurb: flatten(product.short_description),
    link: product.permalink ?? null,
    updated_at: product.date_modified ?? null,
    variants: variants.map((variant) => ({
      variant_id: variant.id,
      sku: blank(variant.sku) ?? null,
      options: Object.fromEntries(variant.attributes.map((attr) => [attr.name, attr.option])),
      price: variant.price,
      availability: variant.stock_status,
      on_hand: variant.manage_stock === true ? variant.stock_quantity : null,
    })),
  };
}
