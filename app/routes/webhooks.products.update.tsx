import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enqueueSyncJob } from "../daraz/queue.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const productId = String((payload as { id: number | string }).id);

  const mapping = await db.productMapping.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId: productId } },
  });

  // Already on Daraz -> a full update; otherwise it still needs mapping
  // before it can be created, but we still record the pending job so it
  // shows up once the merchant maps it.
  await enqueueSyncJob(shop, productId, mapping?.darazItemId ? "update" : "create");

  return new Response();
};
