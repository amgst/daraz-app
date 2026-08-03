import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enqueueSyncJob } from "../daraz/queue.server";

const PRODUCT_FOR_INVENTORY_ITEM = `#graphql
  query ProductForInventoryItem($id: ID!) {
    inventoryItem(id: $id) {
      variant { product { id } }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  if (!admin) return new Response();

  const inventoryItemId = (payload as { inventory_item_id: number }).inventory_item_id;
  const gid = `gid://shopify/InventoryItem/${inventoryItemId}`;

  const response = await admin.graphql(PRODUCT_FOR_INVENTORY_ITEM, {
    variables: { id: gid },
  });
  const json = await response.json();
  const productGid = json.data?.inventoryItem?.variant?.product?.id as
    | string
    | undefined;
  if (!productGid) return new Response();

  const productId = productGid.split("/").pop()!;
  await enqueueSyncJob(shop, productId, "price_qty");

  return new Response();
};
