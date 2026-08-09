import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Shopify's mandatory GDPR webhook: fired when a customer (or Shopify, on
// their behalf) requests the data a shop's apps hold about them. This app
// never stores Shopify customer records (no customer id/email/phone is ever
// persisted - ProductMapping/SyncJob/DarazAccount are shop-scoped only, and
// DarazOrder mirrors Daraz's own order data, not Shopify customer data), so
// there is nothing to return - acknowledging is the correct response.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, payload);
  return new Response();
};