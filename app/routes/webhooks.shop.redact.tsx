import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Shopify's mandatory GDPR webhook: fired ~48 hours after an app is
// uninstalled, requiring erasure of the shop's data. DarazAccount is the
// parent of ProductMapping/SyncJob/DarazOrder (all onDelete: Cascade in the
// schema), so deleting it purges everything this app holds for the shop in
// one query. Session rows are also cleared defensively, in case the
// app/uninstalled webhook was missed.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, payload);

  await db.darazAccount.deleteMany({ where: { shop } });
  await db.session.deleteMany({ where: { shop } });

  return new Response();
};