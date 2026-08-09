import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Shopify's mandatory GDPR webhook: fired ~10 days after a redaction request
// (or app uninstall), requiring erasure of any data held about the named
// customer. Same reasoning as customers/data_request - this app never
// persists Shopify customer records, so there is nothing to redact.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, payload);
  return new Response();
};