import db from "../db.server";
import type { SyncJobType } from "@prisma/client";

// Cheap de-dupe: don't stack up duplicate pending jobs for the same product
// (a burst of Shopify webhooks for one edit is common).
export async function enqueueSyncJob(
  shop: string,
  shopifyProductId: string,
  type: SyncJobType,
) {
  const existing = await db.syncJob.findFirst({
    where: { shop, shopifyProductId, status: "pending" },
  });
  if (existing) return existing;

  return db.syncJob.create({
    data: { shop, shopifyProductId, type },
  });
}
