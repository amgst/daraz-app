import db from "../db.server";
import { getValidAccessToken } from "./tokens.server";
import { getOrders, getOrderItems } from "./client.server";

// v1: mirrors Daraz orders into our own DB for display only - nothing is
// pushed to Shopify's Order object (that needs Shopify's protected
// orderCreate scope, which this app hasn't requested yet).
export async function importDarazOrders(
  shop: string,
): Promise<{ imported: number; updated: number }> {
  const darazSession = await getValidAccessToken(shop);
  if (!darazSession) {
    throw new Error(`Shop ${shop} has no connected Daraz account`);
  }
  const darazOpts = {
    accessToken: darazSession.accessToken,
    country: darazSession.country,
  };

  const orders = await getOrders(darazOpts);

  let imported = 0;
  let updated = 0;

  for (const order of orders) {
    const items = await getOrderItems(darazOpts, order.orderId);
    const existing = await db.darazOrder.findUnique({
      where: { shop_darazOrderId: { shop, darazOrderId: order.orderId } },
      select: { id: true },
    });

    await db.darazOrder.upsert({
      where: { shop_darazOrderId: { shop, darazOrderId: order.orderId } },
      create: {
        shop,
        darazOrderId: order.orderId,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        status: order.status,
        itemsCount: order.itemsCount,
        totalAmount: order.totalAmount,
        currency: order.currency,
        darazCreatedAt: order.createdAt ? new Date(order.createdAt) : null,
        darazUpdatedAt: order.updatedAt ? new Date(order.updatedAt) : null,
        items: {
          create: items.map((item) => ({
            darazOrderItemId: item.orderItemId,
            sku: item.sku,
            name: item.name,
            imageUrl: item.imageUrl,
            price: item.price,
            currency: item.currency,
            status: item.status,
          })),
        },
      },
      update: {
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        status: order.status,
        itemsCount: order.itemsCount,
        totalAmount: order.totalAmount,
        currency: order.currency,
        darazUpdatedAt: order.updatedAt ? new Date(order.updatedAt) : null,
        // Full refresh rather than diffing - order line items don't change
        // often enough to justify per-item upsert complexity here.
        items: {
          deleteMany: {},
          create: items.map((item) => ({
            darazOrderItemId: item.orderItemId,
            sku: item.sku,
            name: item.name,
            imageUrl: item.imageUrl,
            price: item.price,
            currency: item.currency,
            status: item.status,
          })),
        },
      },
    });

    if (existing) {
      updated++;
    } else {
      imported++;
    }
  }

  return { imported, updated };
}
