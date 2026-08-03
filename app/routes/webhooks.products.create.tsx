import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enqueueSyncJob } from "../daraz/queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const productId = String((payload as { id: number | string }).id);

  await enqueueSyncJob(shop, productId, "create");

  return new Response();
};
