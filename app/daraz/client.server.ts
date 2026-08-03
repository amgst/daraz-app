import crypto from "node:crypto";
import {
  apiHostFor,
  oauthHostFor,
  getDarazAppCredentials,
  getDarazRedirectUri,
} from "./config.server";

// Daraz Open Platform is built on the same "IOP" gateway framework as
// Lazada Open Platform. Every call - authenticated or not - is signed the
// same way:
//   1. system params (app_key, timestamp, sign_method) + business params
//   2. sort params by key (byte order)
//   3. concatenate: apiPath + key1 + value1 + key2 + value2 + ...
//   4. HMAC-SHA256 with app_secret, uppercase hex
// NOTE: exact business-parameter shapes for each endpoint below should be
// cross-checked against the live docs at open.daraz.com/doc/api.htm (a JS
// SPA we could not scrape headlessly) before relying on them in production -
// the signing/transport layer is standard IOP and can be trusted as-is.
function sign(apiPath: string, params: Record<string, string>, appSecret: string): string {
  const sortedKeys = Object.keys(params).sort();
  let base = apiPath;
  for (const key of sortedKeys) {
    base += key + params[key];
  }
  return crypto
    .createHmac("sha256", appSecret)
    .update(base, "utf8")
    .digest("hex")
    .toUpperCase();
}

interface RequestOptions {
  apiPath: string;
  params?: Record<string, string>;
  accessToken?: string;
  apiHost: string;
  method?: "GET" | "POST";
}

export class DarazApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "DarazApiError";
    this.code = code;
  }
}

async function request<T = unknown>({
  apiPath,
  params = {},
  accessToken,
  apiHost,
  method = "POST",
}: RequestOptions): Promise<T> {
  const { appKey, appSecret } = getDarazAppCredentials();

  const allParams: Record<string, string> = {
    ...params,
    app_key: appKey,
    timestamp: String(Date.now()),
    sign_method: "sha256",
    ...(accessToken ? { access_token: accessToken } : {}),
  };
  allParams.sign = sign(apiPath, allParams, appSecret);

  const url = new URL(apiHost + apiPath);
  const body = new URLSearchParams(allParams);

  const response = await fetch(
    method === "GET" ? `${url.toString()}?${body.toString()}` : url.toString(),
    {
      method,
      headers:
        method === "POST"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : undefined,
      body: method === "POST" ? body.toString() : undefined,
    },
  );

  const json = (await response.json()) as {
    code?: string;
    type?: string;
    message?: string;
    data?: unknown;
  } & Record<string, unknown>;

  // IOP-style APIs return HTTP 200 with an error `code` in the body on failure.
  if (json.code && json.code !== "0") {
    throw new DarazApiError(json.message ?? "Daraz API error", json.code);
  }

  return json as T;
}

// ---- OAuth ----
// The authorize page and token endpoints live on the seller's own country
// host (e.g. https://api.daraz.pk), not a separate global auth host - so the
// country has to be chosen by the merchant before we can build this URL.

export function getAuthorizeUrl(state: string, country: string): string {
  const { appKey } = getDarazAppCredentials();
  const url = new URL("/oauth/authorize", oauthHostFor(country));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("force_auth", "true");
  url.searchParams.set("client_id", appKey);
  url.searchParams.set("redirect_uri", getDarazRedirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

export interface DarazTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  refresh_expires_in: number; // seconds
  account: string;
  account_id?: string;
  country_user_info?: Array<{
    country: string;
    seller_id: string;
    short_code: string;
  }>;
}

export async function exchangeCodeForToken(
  code: string,
  country: string,
): Promise<DarazTokenResponse> {
  return request<DarazTokenResponse>({
    apiPath: "/auth/token/create",
    params: { code },
    apiHost: apiHostFor(country),
  });
}

export async function refreshAccessToken(
  refreshToken: string,
  country: string,
): Promise<DarazTokenResponse> {
  return request<DarazTokenResponse>({
    apiPath: "/auth/token/refresh",
    params: { refresh_token: refreshToken },
    apiHost: apiHostFor(country),
  });
}

// ---- Product ----

export interface DarazProductImage {
  url: string;
}

export interface DarazSku {
  SellerSku: string;
  price: string;
  quantity: string;
  Images?: string[];
  [attribute: string]: string | string[] | undefined;
}

export interface CreateProductInput {
  primaryCategoryId: string;
  name: string;
  description: string;
  brandName?: string;
  attributes: Record<string, string>;
  skus: DarazSku[];
}

interface DarazProductClientOptions {
  accessToken: string;
  country: string;
}

export async function uploadImage(
  { accessToken, country }: DarazProductClientOptions,
  imageBase64: string,
): Promise<string> {
  const result = await request<{ data: { image: { url: string } } }>({
    apiPath: "/image/upload",
    params: { image: imageBase64 },
    accessToken,
    apiHost: apiHostFor(country),
  });
  return result.data.image.url;
}

export async function createProduct(
  { accessToken, country }: DarazProductClientOptions,
  input: CreateProductInput,
): Promise<{ item_id: string; sku_list: Array<{ SellerSku: string; SkuId: string }> }> {
  const payload = buildProductPayload(input);
  const result = await request<{
    data: {
      item_id: string;
      sku_list: Array<{ SellerSku: string; SkuId: string }>;
    };
  }>({
    apiPath: "/product/create",
    params: { payload },
    accessToken,
    apiHost: apiHostFor(country),
  });
  return result.data;
}

export async function updateProduct(
  { accessToken, country }: DarazProductClientOptions,
  itemId: string,
  input: CreateProductInput,
): Promise<void> {
  const payload = buildProductPayload(input, itemId);
  await request({
    apiPath: "/product/update",
    params: { payload },
    accessToken,
    apiHost: apiHostFor(country),
  });
}

export async function updatePriceQuantity(
  { accessToken, country }: DarazProductClientOptions,
  itemId: string,
  skus: Array<{ SellerSku: string; price: string; quantity: string }>,
): Promise<void> {
  const skusXml = skus
    .map(
      (sku) =>
        `<Sku><SellerSku>${escapeXml(sku.SellerSku)}</SellerSku><price>${sku.price}</price><quantity>${sku.quantity}</quantity></Sku>`,
    )
    .join("");
  const payload = `<Request><Product><Item><ItemId>${itemId}</ItemId></Item><Skus>${skusXml}</Skus></Product></Request>`;
  await request({
    apiPath: "/product/price_quantity/update",
    params: { payload },
    accessToken,
    apiHost: apiHostFor(country),
  });
}

export interface DarazExistingProduct {
  item_id: string;
  primary_category: string;
  attributes: { name?: string };
  skus: Array<{ SkuId: string; SellerSku: string; price: string; quantity: string }>;
}

// Searches the seller's existing Daraz catalog - used to link an already-listed
// Daraz product to a Shopify product instead of creating a duplicate, or to
// browse the catalog for import. Verify the exact filter/response shape
// against the live docs before relying on it; this follows the general
// IOP "/products/get" pagination pattern.
// Daraz returns item_id/primary_category/SkuId as raw JSON numbers, not
// strings, despite the rest of this client treating them as strings (learned
// the hard way: a bare `primary_category` blew up a Shopify GraphQL call
// expecting a String). Coerce everything ID-shaped right at the parse
// boundary so no downstream caller has to think about it.
function normalizeExistingProduct(raw: {
  item_id: unknown;
  primary_category: unknown;
  attributes: { name?: string };
  skus: Array<{ SkuId: unknown; SellerSku: unknown; price: unknown; quantity: unknown }>;
}): DarazExistingProduct {
  return {
    item_id: String(raw.item_id),
    primary_category: String(raw.primary_category),
    attributes: raw.attributes,
    skus: raw.skus.map((sku) => ({
      SkuId: String(sku.SkuId),
      SellerSku: String(sku.SellerSku),
      price: String(sku.price),
      quantity: String(sku.quantity),
    })),
  };
}

export async function getProducts(
  { accessToken, country }: DarazProductClientOptions,
  filter: { sellerSku?: string; search?: string; limit?: number; offset?: number },
): Promise<DarazExistingProduct[]> {
  const result = await request<{
    data: { products: Parameters<typeof normalizeExistingProduct>[0][] };
  }>({
    apiPath: "/products/get",
    params: {
      filter: "all",
      limit: String(filter.limit ?? 20),
      offset: String(filter.offset ?? 0),
      ...(filter.sellerSku ? { sku_seller_list: JSON.stringify([filter.sellerSku]) } : {}),
      ...(filter.search ? { search: filter.search } : {}),
    },
    accessToken,
    apiHost: apiHostFor(country),
    method: "GET",
  });
  return (result.data?.products ?? []).map(normalizeExistingProduct);
}

export interface DarazSkuDetail {
  SkuId: string;
  SellerSku: string;
  price: string;
  quantity: string;
  images: string[];
  saleProp: Record<string, string>;
  specialPrice: string | null;
  specialFromDate: string | null;
  specialToDate: string | null;
  packageWeightKg: number | null;
}

export interface DarazVariationDef {
  key: string; // e.g. "color_family" - matches the keys in each sku's saleProp
  label: string; // e.g. "Color Family" - human-readable, shown as the Shopify option name
}

export interface DarazProductDetail {
  item_id: string;
  primary_category: string;
  name: string;
  description: string;
  brand: string | null;
  images: string[];
  variations: DarazVariationDef[];
  skus: DarazSkuDetail[];
}

// Confirmed against a real /product/item/get response (2026-08): images are
// a plain top-level string array, price/special_price are separate fields
// (special_price only actually applies within special_from_date/to_date),
// and per-SKU option values live in `saleProp` (e.g. {color_family:
// "Brown"}), with `variation.VariationN.name`/`label` giving the matching
// human-readable option name for each saleProp key.
export async function getProductDetail(
  { accessToken, country }: DarazProductClientOptions,
  itemId: string,
): Promise<DarazProductDetail> {
  const result = await request<{
    data: {
      item_id: unknown;
      primary_category: unknown;
      images?: string[];
      attributes: {
        name?: string;
        description?: string;
        short_description?: string;
        brand?: string;
      };
      variation?: Record<string, { name: string; label: string }>;
      skus: Array<{
        SkuId: unknown;
        SellerSku: unknown;
        price: unknown;
        quantity: unknown;
        Images?: string[];
        saleProp?: Record<string, unknown>;
        special_price?: unknown;
        special_from_date?: string;
        special_to_date?: string;
        package_weight?: unknown;
      }>;
    };
  }>({
    apiPath: "/product/item/get",
    params: { item_id: itemId },
    accessToken,
    apiHost: apiHostFor(country),
    method: "GET",
  });

  const data = result.data;

  const variations = Object.values(data.variation ?? {}).map((v) => ({
    key: v.name,
    label: v.label,
  }));

  const skus: DarazSkuDetail[] = data.skus.map((sku) => {
    const packageWeightKg = sku.package_weight !== undefined ? Number(sku.package_weight) : null;
    return {
      SkuId: String(sku.SkuId),
      SellerSku: String(sku.SellerSku),
      price: String(sku.price),
      quantity: String(sku.quantity),
      images: sku.Images ?? [],
      saleProp: Object.fromEntries(
        Object.entries(sku.saleProp ?? {}).map(([k, v]) => [k, String(v)]),
      ),
      specialPrice: sku.special_price !== undefined ? String(sku.special_price) : null,
      specialFromDate: sku.special_from_date ?? null,
      specialToDate: sku.special_to_date ?? null,
      packageWeightKg: Number.isFinite(packageWeightKg) ? packageWeightKg : null,
    };
  });

  const images =
    data.images ?? skus.flatMap((sku) => sku.images).filter((v, i, a) => a.indexOf(v) === i);

  return {
    item_id: String(data.item_id),
    primary_category: String(data.primary_category),
    name: data.attributes?.name ?? `Daraz item ${data.item_id}`,
    description: data.attributes?.description ?? data.attributes?.short_description ?? "",
    brand: data.attributes?.brand && data.attributes.brand !== "No Brand" ? data.attributes.brand : null,
    images,
    variations,
    skus,
  };
}

// A sku's special_price only actually applies to purchases within its date
// window - outside that window it's stale and the regular price should win.
export function effectivePrice(sku: DarazSkuDetail): { price: string; compareAtPrice: string | null } {
  if (!sku.specialPrice || !sku.specialFromDate || !sku.specialToDate) {
    return { price: sku.price, compareAtPrice: null };
  }
  const now = Date.now();
  const from = new Date(sku.specialFromDate).getTime();
  const to = new Date(sku.specialToDate).getTime();
  if (Number.isFinite(from) && Number.isFinite(to) && now >= from && now <= to) {
    return { price: sku.specialPrice, compareAtPrice: sku.price };
  }
  return { price: sku.price, compareAtPrice: null };
}

// Debug-only: returns the untouched raw JSON for a product, bypassing all
// the field-name guessing above. Used to actually see Daraz's real response
// shape instead of continuing to guess at it (e.g. where images live).
export async function getRawProductDetail(
  { accessToken, country }: DarazProductClientOptions,
  itemId: string,
): Promise<unknown> {
  return request({
    apiPath: "/product/item/get",
    params: { item_id: itemId },
    accessToken,
    apiHost: apiHostFor(country),
    method: "GET",
  });
}

export interface DarazCategoryNode {
  id: string;
  name: string;
  isLeaf: boolean;
  children: DarazCategoryNode[];
}

// Normalizes the raw category tree response into a consistent shape - the
// exact field names (category_id vs id, children vs sub_category_list) are
// unverified against live docs, so this tries the common IOP/Lazada variants
// and silently drops anything it can't recognize rather than throwing.
function normalizeCategoryNode(raw: unknown): DarazCategoryNode | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = obj.category_id ?? obj.categoryId ?? obj.id;
  const name = obj.name ?? obj.name_local ?? obj.category_name;
  if (id === undefined || id === null || typeof name !== "string") return null;

  const rawChildren =
    (obj.children as unknown[]) ??
    (obj.sub_category_list as unknown[]) ??
    (obj.child_category_list as unknown[]) ??
    [];
  const children = Array.isArray(rawChildren)
    ? rawChildren.map(normalizeCategoryNode).filter((n): n is DarazCategoryNode => n !== null)
    : [];

  const isLeaf =
    typeof obj.leaf === "boolean" ? obj.leaf : children.length === 0;

  return { id: String(id), name, isLeaf, children };
}

export async function getCategoryTree(
  { accessToken, country }: DarazProductClientOptions,
): Promise<DarazCategoryNode[]> {
  const result = await request<{ data?: unknown[] }>({
    apiPath: "/category/tree/get",
    params: { language_code: "en" },
    accessToken,
    apiHost: apiHostFor(country),
    method: "GET",
  });
  const raw = Array.isArray(result.data) ? result.data : [];
  return raw.map(normalizeCategoryNode).filter((n): n is DarazCategoryNode => n !== null);
}

export async function getCategoryAttributes(
  { accessToken, country }: DarazProductClientOptions,
  categoryId: string,
): Promise<unknown> {
  return request({
    apiPath: "/category/attributes/get",
    params: { primary_category_id: categoryId, language_code: "en" },
    accessToken,
    apiHost: apiHostFor(country),
    method: "GET",
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// The product create/update APIs take a single XML `payload` business
// parameter (not individual form fields) - this mirrors the IOP product API
// shape; verify the exact tag set against the live docs before shipping.
function buildProductPayload(input: CreateProductInput, itemId?: string): string {
  const attributesXml = Object.entries(input.attributes)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join("");

  const skusXml = input.skus
    .map((sku) => {
      const { SellerSku, price, quantity, Images, ...rest } = sku;
      const imagesXml = Images?.length
        ? `<Images>${Images.map((url) => `<Image>${escapeXml(url)}</Image>`).join("")}</Images>`
        : "";
      const restXml = Object.entries(rest)
        .map(([key, value]) =>
          Array.isArray(value) ? "" : `<${key}>${escapeXml(String(value ?? ""))}</${key}>`,
        )
        .join("");
      return `<Sku><SellerSku>${escapeXml(SellerSku)}</SellerSku><price>${price}</price><quantity>${quantity}</quantity>${restXml}${imagesXml}</Sku>`;
    })
    .join("");

  return `<Request><Product>${itemId ? `<ItemId>${itemId}</ItemId>` : ""}<PrimaryCategory>${input.primaryCategoryId}</PrimaryCategory><Attributes>${attributesXml}<name>${escapeXml(input.name)}</name><description>${escapeXml(input.description)}</description>${input.brandName ? `<brand>${escapeXml(input.brandName)}</brand>` : ""}</Attributes><Skus>${skusXml}</Skus></Product></Request>`;
}
