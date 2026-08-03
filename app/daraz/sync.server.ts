import type { SyncJob } from "@prisma/client";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { getValidAccessToken } from "./tokens.server";
import {
  createProduct,
  updateProduct,
  updatePriceQuantity,
  uploadImage,
  getProductDetail,
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

const PRODUCT_CREATE_MUTATION = `#graphql
  mutation DarazImportProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        variants(first: 1) {
          nodes { id inventoryItem { id } }
        }
      }
      userErrors { field message }
    }
  }
`;

// productCreate always auto-creates one "Default Title" variant even with no
// variant input - productVariantsBulkCreate-ing on top of that collides with
// it ("The variant 'Default Title' already exists"). Update that existing
// variant with the first Daraz SKU instead of creating a competing one.
const VARIANTS_BULK_UPDATE_MUTATION = `#graphql
  mutation DarazImportVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_CREATE_MUTATION = `#graphql
  mutation DarazImportVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { id inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

const PRODUCT_CREATE_MEDIA_MUTATION = `#graphql
  mutation DarazImportProductMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      mediaUserErrors { field message }
    }
  }
`;

const PRIMARY_LOCATION_QUERY = `#graphql
  query DarazImportPrimaryLocation {
    locations(first: 1) { nodes { id } }
  }
`;

// productCreate sets status: ACTIVE but doesn't publish the product to any
// sales channel - without this, the admin shows "Preview" instead of "View"
// and the product isn't actually visible on the storefront.
const ONLINE_STORE_PUBLICATION_QUERY = `#graphql
  query DarazImportOnlineStorePublication {
    publications(first: 10) {
      nodes { id name }
    }
  }
`;

const PUBLISH_MUTATION = `#graphql
  mutation DarazImportPublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

const SET_INVENTORY_MUTATION = `#graphql
  mutation DarazImportSetInventory($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors { field message }
    }
  }
`;

// Creates a brand-new Shopify product from a Daraz listing that has no
// Shopify counterpart yet (the reverse of syncProduct, which goes
// Shopify -> Daraz). Used by the "Import from Daraz" page.
export async function importDarazProduct(
  shop: string,
  darazItemId: string,
): Promise<string> {
  const darazSession = await getValidAccessToken(shop);
  if (!darazSession) {
    throw new Error(`Shop ${shop} has no connected Daraz account`);
  }
  const darazOpts = {
    accessToken: darazSession.accessToken,
    country: darazSession.country,
  };

  const detail = await getProductDetail(darazOpts, darazItemId);
  const { admin } = await unauthenticated.admin(shop);

  const createResponse = await admin.graphql(PRODUCT_CREATE_MUTATION, {
    variables: {
      product: {
        title: detail.name,
        descriptionHtml: detail.description,
        productType: detail.primary_category,
      },
    },
  });
  const createJson = await createResponse.json();
  const createErrors = createJson.data?.productCreate?.userErrors ?? [];
  if (createErrors.length > 0) {
    throw new Error(
      `Shopify productCreate failed: ${createErrors.map((e: { message: string }) => e.message).join(", ")}`,
    );
  }
  const shopifyProductGid = createJson.data?.productCreate?.product?.id as string;
  const shopifyProductId = shopifyProductGid.split("/").pop()!;
  const defaultVariant = createJson.data?.productCreate?.product?.variants?.nodes?.[0] as
    | { id: string; inventoryItem: { id: string } }
    | undefined;

  const allVariants: Array<{ id: string; inventoryItem: { id: string } }> = [];

  if (detail.skus.length > 0 && defaultVariant) {
    const [firstSku, ...restSkus] = detail.skus;

    const updateResponse = await admin.graphql(VARIANTS_BULK_UPDATE_MUTATION, {
      variables: {
        productId: shopifyProductGid,
        variants: [
          {
            id: defaultVariant.id,
            price: firstSku.price,
            inventoryItem: { sku: firstSku.SellerSku },
          },
        ],
      },
    });
    const updateJson = await updateResponse.json();
    const updateErrors = updateJson.data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (updateErrors.length > 0) {
      throw new Error(
        `Shopify variant update failed: ${updateErrors.map((e: { message: string }) => e.message).join(", ")}`,
      );
    }
    allVariants.push(
      ...((updateJson.data?.productVariantsBulkUpdate?.productVariants ?? []) as typeof allVariants),
    );

    if (restSkus.length > 0) {
      const createResponse = await admin.graphql(VARIANTS_BULK_CREATE_MUTATION, {
        variables: {
          productId: shopifyProductGid,
          variants: restSkus.map((sku) => ({
            price: sku.price,
            inventoryItem: { sku: sku.SellerSku },
          })),
        },
      });
      const createVariantsJson = await createResponse.json();
      const createVariantErrors = createVariantsJson.data?.productVariantsBulkCreate?.userErrors ?? [];
      if (createVariantErrors.length > 0) {
        throw new Error(
          `Shopify variant creation failed: ${createVariantErrors.map((e: { message: string }) => e.message).join(", ")}`,
        );
      }
      allVariants.push(
        ...((createVariantsJson.data?.productVariantsBulkCreate?.productVariants ??
          []) as typeof allVariants),
      );
    }
  }

  if (detail.images.length > 0) {
    const mediaResponse = await admin.graphql(PRODUCT_CREATE_MEDIA_MUTATION, {
      variables: {
        productId: shopifyProductGid,
        media: detail.images.map((url) => ({
          originalSource: url,
          mediaContentType: "IMAGE",
        })),
      },
    });
    const mediaJson = await mediaResponse.json();
    const mediaErrors = mediaJson.data?.productCreateMedia?.mediaUserErrors ?? [];
    if (mediaErrors.length > 0) {
      // Don't fail the whole import over images - the product/variants are
      // already created and worth keeping either way.
      console.error(
        `Daraz import: productCreateMedia errors for ${shopifyProductId}:`,
        mediaErrors,
      );
    }
  }

  // Requires the read_publications/write_publications scopes, which this app
  // doesn't have yet (needs a shopify.app.toml scope update + merchant
  // re-consent to add). Never let a missing-scope error here kill an
  // otherwise-successful import - the product/variants/images/inventory are
  // already done and worth keeping; publishing can be added later or done
  // manually in the admin in the meantime.
  try {
    const publicationsResponse = await admin.graphql(ONLINE_STORE_PUBLICATION_QUERY);
    const publicationsJson = await publicationsResponse.json();
    const onlineStorePublicationId = (
      publicationsJson.data?.publications?.nodes as Array<{ id: string; name: string }> | undefined
    )?.find((p) => p.name === "Online Store")?.id;
    if (onlineStorePublicationId) {
      await admin.graphql(PUBLISH_MUTATION, {
        variables: {
          id: shopifyProductGid,
          input: [{ publicationId: onlineStorePublicationId }],
        },
      });
    }
  } catch (error) {
    console.error(`Daraz import: publish-to-Online-Store skipped for ${shopifyProductId}:`, error);
  }

  const locationResponse = await admin.graphql(PRIMARY_LOCATION_QUERY);
  const locationJson = await locationResponse.json();
  const locationId = locationJson.data?.locations?.nodes?.[0]?.id as string | undefined;

  if (locationId) {
    await admin.graphql(SET_INVENTORY_MUTATION, {
      variables: {
        input: {
          reason: "correction",
          setQuantities: allVariants.map((variant, index) => ({
            inventoryItemId: variant.inventoryItem.id,
            locationId,
            quantity: Number(detail.skus[index]?.quantity ?? 0),
          })),
        },
      },
    });
  }

  await db.productMapping.upsert({
    where: { shop_shopifyProductId: { shop, shopifyProductId } },
    create: {
      shop,
      shopifyProductId,
      darazItemId: detail.item_id,
      darazSkuId: detail.skus[0]?.SkuId ?? null,
      darazCategoryId: detail.primary_category,
      syncStatus: "synced",
      lastSyncedAt: new Date(),
    },
    update: {
      darazItemId: detail.item_id,
      darazSkuId: detail.skus[0]?.SkuId ?? null,
      darazCategoryId: detail.primary_category,
      syncStatus: "synced",
      lastSyncedAt: new Date(),
      lastError: null,
    },
  });

  return shopifyProductId;
}
