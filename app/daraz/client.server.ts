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
// Daraz product to a Shopify product instead of creating a duplicate. Verify
// the exact filter/response shape against the live docs before relying on it;
// this follows the general IOP "/products/get" pagination pattern.
export async function getProducts(
  { accessToken, country }: DarazProductClientOptions,
  filter: { sellerSku?: string; search?: string },
): Promise<DarazExistingProduct[]> {
  const result = await request<{
    data: { products: DarazExistingProduct[] };
  }>({
    apiPath: "/products/get",
    params: {
      filter: "all",
      limit: "20",
      offset: "0",
      ...(filter.sellerSku ? { sku_seller_list: JSON.stringify([filter.sellerSku]) } : {}),
      ...(filter.search ? { search: filter.search } : {}),
    },
    accessToken,
    apiHost: apiHostFor(country),
    method: "GET",
  });
  return result.data?.products ?? [];
}

export async function getCategoryTree(
  { accessToken, country }: DarazProductClientOptions,
): Promise<unknown> {
  return request({
    apiPath: "/category/tree/get",
    params: { language_code: "en" },
    accessToken,
    apiHost: apiHostFor(country),
    method: "GET",
  });
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
