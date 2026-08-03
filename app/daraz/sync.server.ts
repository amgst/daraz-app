import type { SyncJob } from "@prisma/client";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { getValidAccessToken } from "./tokens.server";
import {
  createProduct,
  updateProduct,
  updatePriceQuantity,
  uploadImage,
  type CreateProductInput,
} from "./client.server";

const PRODUCT_QUERY = `#graphql
  query DarazSyncProduct($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      vendor
      images(first: 5) {
        nodes { url }
      }
      variants(first: 100) {
        nodes {
          sku
          price
          inventoryQuantity
        }
      }
    }
  }
`;

interface ShopifyProduct {
  id: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  images: { nodes: Array<{ url: string }> };
  variants: {
    nodes: Array<{ sku: string | null; price: string; inventoryQuantity: number | null }>;
  };
}

async function fetchShopifyProduct(
  shop: string,
  shopifyProductId: string,
): Promise<ShopifyProduct> {
  const { admin } = await unauthenticated.admin(shop);
  const gid = shopifyProductId.startsWith("gid://")
    ? shopifyProductId
    : `gid://shopify/Product/${shopifyProductId}`;

  const response = await admin.graphql(PRODUCT_QUERY, { variables: { id: gid } });
  const json = await response.json();
  const product = json.data?.product as ShopifyProduct | null;
  if (!product) {
    throw new Error(`Shopify product ${shopifyProductId} not found`);
  }
  return product;
}

async function uploadProductImages(
  darazOpts: { accessToken: string; country: string },
  imageUrls: string[],
): Promise<string[]> {
  const uploaded: string[] = [];
  for (const url of imageUrls) {
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const darazUrl = await uploadImage(darazOpts, buffer.toString("base64"));
    uploaded.push(darazUrl);
  }
  return uploaded;
}

// Core sync: builds a Daraz product payload from the current Shopify product
// plus the merchant's saved category/attribute mapping, then creates or
// updates it on Daraz. Throws on any failure - callers (queue processor /
// manual "Sync now" action) are responsible for persisting status.
export async function syncProduct(
  shop: string,
  shopifyProductId: string,
  type: "create" | "update" | "price_qty",
): Promise<void> {
  const mapping = await db.productMapping.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId } },
  });

  if (!mapping || !mapping.darazCategoryId || !mapping.attributesJson) {
    await db.productMapping.upsert({
      where: { shop_shopifyProductId: { shop, shopifyProductId } },
      create: { shop, shopifyProductId, syncStatus: "unmapped" },
      update: { syncStatus: "unmapped" },
    });
    throw new Error(
      "Product has no Daraz category/attribute mapping yet - map it before syncing",
    );
  }

  const darazSession = await getValidAccessToken(shop);
  if (!darazSession) {
    throw new Error(`Shop ${shop} has no connected Daraz account`);
  }
  const darazOpts = {
    accessToken: darazSession.accessToken,
    country: darazSession.country,
  };

  const product = await fetchShopifyProduct(shop, shopifyProductId);

  // Fast path: only price/quantity changed and the product already exists on Daraz.
  if (type === "price_qty" && mapping.darazItemId) {
    await updatePriceQuantity(
      darazOpts,
      mapping.darazItemId,
      product.variants.nodes.map((variant, index) => ({
        SellerSku: variant.sku || `${shopifyProductId}-${index}`,
        price: variant.price,
        quantity: String(variant.inventoryQuantity ?? 0),
      })),
    );
    await db.productMapping.update({
      where: { shop_shopifyProductId: { shop, shopifyProductId } },
      data: { syncStatus: "synced", lastSyncedAt: new Date(), lastError: null },
    });
    return;
  }

  const darazImageUrls = await uploadProductImages(
    darazOpts,
    product.images.nodes.map((n) => n.url),
  );

  const input: CreateProductInput = {
    primaryCategoryId: mapping.darazCategoryId,
    name: product.title,
    description: product.descriptionHtml || product.title,
    brandName: product.vendor || undefined,
    attributes: JSON.parse(mapping.attributesJson) as Record<string, string>,
    skus: product.variants.nodes.map((variant, index) => ({
      SellerSku: variant.sku || `${shopifyProductId}-${index}`,
      price: variant.price,
      quantity: String(variant.inventoryQuantity ?? 0),
      Images: darazImageUrls,
    })),
  };

  if (mapping.darazItemId) {
    await updateProduct(darazOpts, mapping.darazItemId, input);
    await db.productMapping.update({
      where: { shop_shopifyProductId: { shop, shopifyProductId } },
      data: { syncStatus: "synced", lastSyncedAt: new Date(), lastError: null },
    });
  } else {
    const created = await createProduct(darazOpts, input);
    const firstSku = created.sku_list[0];
    await db.productMapping.update({
      where: { shop_shopifyProductId: { shop, shopifyProductId } },
      data: {
        darazItemId: created.item_id,
        darazSkuId: firstSku?.SkuId ?? null,
        syncStatus: "synced",
        lastSyncedAt: new Date(),
        lastError: null,
      },
    });
  }
}

// Drains one pending SyncJob, marking it processing -> done/failed.
export async function processSyncJob(job: SyncJob): Promise<void> {
  await db.syncJob.update({
    where: { id: job.id },
    data: { status: "processing", attempts: { increment: 1 } },
  });

  try {
    await syncProduct(job.shop, job.shopifyProductId, job.type);
    await db.syncJob.update({
      where: { id: job.id },
      data: { status: "done" },
    });
  } catch (error) {
    await db.syncJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        lastError: error instanceof Error ? error.message : String(error),
      },
    });
    await db.productMapping.updateMany({
      where: { shop: job.shop, shopifyProductId: job.shopifyProductId },
      data: {
        syncStatus: "error",
        lastError: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

// No Vercel Cron (Hobby plan caps scheduled Cron Jobs to once/day) - webhooks
// enqueue SyncJob rows purely as a "needs sync" signal, and the merchant
// drains them on demand from the products page ("Sync all pending" button).
const DRAIN_BATCH_SIZE = 20;

export async function drainPendingSyncJobs(shop: string): Promise<number> {
  const jobs = await db.syncJob.findMany({
    where: { shop, status: "pending" },
    orderBy: { createdAt: "asc" },
    take: DRAIN_BATCH_SIZE,
  });
  for (const job of jobs) {
    await processSyncJob(job);
  }
  return jobs.length;
}

// Keeps a product's "pending" queue indicator from going stale when it was
// synced directly (the per-product "Sync now" button) rather than drained.
export async function clearPendingSyncJobs(
  shop: string,
  shopifyProductId: string,
): Promise<void> {
  await db.syncJob.updateMany({
    where: { shop, shopifyProductId, status: "pending" },
    data: { status: "done" },
  });
}
