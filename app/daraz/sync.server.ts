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
  effectivePrice,
  type CreateProductInput,
  type DarazSkuDetail,
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

// When productOptions is declared, Shopify auto-creates one variant per
// combination of option values - selectedOptions on each is what lets us
// match each auto-created variant back to the Daraz SKU it should carry.
const PRODUCT_CREATE_MUTATION = `#graphql
  mutation DarazImportProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        variants(first: 100) {
          nodes {
            id
            inventoryItem { id }
            selectedOptions { name value }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

// productCreate always auto-creates variant(s) even with no explicit variant
// input - productVariantsBulkCreate-ing on top of those collides with them
// ("The variant 'Default Title' already exists"). Update the auto-created
// variants with matching Daraz SKUs instead of creating competing ones.
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

  // Build Shopify product options from Daraz's variation schema, using only
  // the values actually present across this item's SKUs (e.g. {name:
  // "Color Family", values: [{name: "Brown"}, {name: "Red"}]}). Declaring
  // these at creation time makes Shopify auto-create one real variant per
  // combination, instead of a single unlabeled "Default Title" variant.
  const productOptions = detail.variations
    .map((v) => ({
      name: v.label,
      values: Array.from(
        new Set(detail.skus.map((s) => s.saleProp[v.key]).filter((val): val is string => Boolean(val))),
      ).map((name) => ({ name })),
    }))
    .filter((opt) => opt.values.length > 0);

  const createResponse = await admin.graphql(PRODUCT_CREATE_MUTATION, {
    variables: {
      product: {
        title: detail.name,
        descriptionHtml: detail.description,
        productType: detail.primary_category,
        ...(detail.brand ? { vendor: detail.brand } : {}),
        ...(productOptions.length > 0 ? { productOptions } : {}),
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
  const initialVariants = (createJson.data?.productCreate?.product?.variants?.nodes ?? []) as Array<{
    id: string;
    inventoryItem: { id: string };
    selectedOptions: Array<{ name: string; value: string }>;
  }>;

  // Match each Daraz SKU to the auto-created variant whose option values
  // correspond to that SKU's saleProp (e.g. Color Family = Brown). Falls
  // back to positional matching when there's exactly one variant/SKU (the
  // common no-variation case) or no options were declared at all.
  const optionSignature = (values: Record<string, string>) =>
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("|");

  const variantBySignature = new Map(
    initialVariants.map((v) => [
      optionSignature(Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value]))),
      v,
    ]),
  );

  const pairs: Array<{
    variant: { id: string; inventoryItem: { id: string } };
    sku: DarazSkuDetail;
  }> = [];
  const unmatchedSkus: DarazSkuDetail[] = [];

  for (const sku of detail.skus) {
    const skuOptionValues = Object.fromEntries(
      detail.variations
        .map((v) => [v.label, sku.saleProp[v.key]] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    const signature = optionSignature(skuOptionValues);
    const variant =
      variantBySignature.get(signature) ??
      (initialVariants.length === 1 && detail.skus.length === 1 ? initialVariants[0] : undefined);
    if (variant) {
      pairs.push({ variant, sku });
      variantBySignature.delete(signature);
    } else {
      unmatchedSkus.push(sku);
    }
  }

  if (pairs.length > 0) {
    const updateResponse = await admin.graphql(VARIANTS_BULK_UPDATE_MUTATION, {
      variables: {
        productId: shopifyProductGid,
        variants: pairs.map(({ variant, sku }) => {
          const { price, compareAtPrice } = effectivePrice(sku);
          return {
            id: variant.id,
            price,
            ...(compareAtPrice ? { compareAtPrice } : {}),
            inventoryItem: {
              sku: sku.SellerSku,
              ...(sku.packageWeightKg
                ? { measurement: { weight: { value: sku.packageWeightKg, unit: "KILOGRAMS" } } }
                : {}),
            },
          };
        }),
      },
    });
    const updateJson = await updateResponse.json();
    const updateErrors = updateJson.data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (updateErrors.length > 0) {
      throw new Error(
        `Shopify variant update failed: ${updateErrors.map((e: { message: string }) => e.message).join(", ")}`,
      );
    }
  }

  // Rare edge case: more Daraz SKUs than Shopify auto-created variants for
  // (e.g. no variation schema but multiple SKUs anyway) - create the rest
  // as unlabeled additional variants rather than dropping them.
  if (unmatchedSkus.length > 0) {
    const extraCreateResponse = await admin.graphql(VARIANTS_BULK_CREATE_MUTATION, {
      variables: {
        productId: shopifyProductGid,
        variants: unmatchedSkus.map((sku) => {
          const { price, compareAtPrice } = effectivePrice(sku);
          return {
            price,
            ...(compareAtPrice ? { compareAtPrice } : {}),
            inventoryItem: { sku: sku.SellerSku },
          };
        }),
      },
    });
    const extraCreateJson = await extraCreateResponse.json();
    const extraCreateErrors = extraCreateJson.data?.productVariantsBulkCreate?.userErrors ?? [];
    if (extraCreateErrors.length > 0) {
      throw new Error(
        `Shopify variant creation failed: ${extraCreateErrors.map((e: { message: string }) => e.message).join(", ")}`,
      );
    }
    const extraVariants = (extraCreateJson.data?.productVariantsBulkCreate?.productVariants ??
      []) as Array<{ id: string; inventoryItem: { id: string } }>;
    unmatchedSkus.forEach((sku, i) => {
      if (extraVariants[i]) pairs.push({ variant: extraVariants[i], sku });
    });
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
          setQuantities: pairs.map(({ variant, sku }) => ({
            inventoryItemId: variant.inventoryItem.id,
            locationId,
            quantity: Number(sku.quantity ?? 0),
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
