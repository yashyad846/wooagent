/**
 * The slice of the WooCommerce REST v3 payloads this connector actually reads.
 * Deliberately partial: fields are added here only when a tool surfaces them.
 * Money arrives as decimal strings and is kept that way -- never parsed to float
 * for display, only for arithmetic we immediately re-fix to 2 places.
 */

export type Money = string;

export interface WcAddress {
  first_name?: string;
  last_name?: string;
  company?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  email?: string;
  phone?: string;
}

export interface WcMetaField {
  id?: number;
  key: string;
  value: unknown;
}

export interface WcLine {
  id: number;
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  sku?: string;
  price: number | Money;
  subtotal?: Money;
  total: Money;
}

export interface WcShippingLine {
  method_title: string;
  total: Money;
}

export interface WcCouponLine {
  code: string;
  discount: Money;
}

export interface WcRefund {
  id: number;
  reason: string;
  /** Negative, as WooCommerce reports it. */
  total: Money;
}

export interface WcOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  date_created: string;
  date_modified?: string;
  date_paid: string | null;
  date_completed: string | null;
  total: Money;
  total_tax?: Money;
  shipping_total?: Money;
  discount_total?: Money;
  payment_method?: string;
  payment_method_title?: string;
  transaction_id?: string;
  customer_id?: number;
  customer_note?: string;
  billing: WcAddress;
  shipping: WcAddress;
  line_items: WcLine[];
  shipping_lines?: WcShippingLine[];
  coupon_lines?: WcCouponLine[];
  refunds?: WcRefund[];
  meta_data?: WcMetaField[];
}

export interface WcNote {
  id: number;
  author: string;
  date_created: string;
  note: string;
  /** true when the note was emailed to the customer rather than kept internal. */
  customer_note: boolean;
}

export interface WcTerm {
  id: number;
  name: string;
}

export interface WcProduct {
  id: number;
  name: string;
  slug?: string;
  sku: string;
  type: string;
  status: string;
  permalink?: string;
  price: Money;
  regular_price: Money;
  sale_price: Money;
  on_sale?: boolean;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  low_stock_amount?: number | null;
  backorders?: string;
  short_description?: string;
  categories?: WcTerm[];
  variations?: number[];
  date_modified?: string;
}

export interface WcVariant {
  id: number;
  sku: string;
  price: Money;
  /** "parent" means the variation defers to the product's own stock setting. */
  manage_stock: boolean | "parent";
  stock_quantity: number | null;
  stock_status: string;
  attributes: Array<{ name: string; option: string }>;
}

export interface WcSetting {
  id: string;
  value: string;
}
