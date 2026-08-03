import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import db from "../db.server";
import { verifyState } from "../daraz/state.server";
import { exchangeCodeForToken } from "../daraz/client.server";
import { encrypt } from "../daraz/crypto.server";
import { isDarazCountry } from "../daraz/config.server";

// Public route - Daraz hits this as a plain top-level browser redirect after
// the seller authorizes, with no Shopify session available. `state` (signed,
// created in app.daraz._index.tsx) is the only way we know which shop this is for.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    throw new Response("Missing code or state", { status: 400 });
  }

  const verified = verifyState(state);
  if (!verified || !isDarazCountry(verified.country)) {
    throw new Response("Invalid or expired state", { status: 400 });
  }
  const { shop, country } = verified;

  const token = await exchangeCodeForToken(code, country);
  const site = token.country_user_info?.find(
    (s) => s.country?.toUpperCase() === country,
  );

  await db.darazAccount.upsert({
    where: { shop },
    create: {
      shop,
      country,
      sellerId: site?.seller_id ?? null,
      accessTokenEnc: encrypt(token.access_token),
      refreshTokenEnc: encrypt(token.refresh_token),
      tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
      refreshTokenExpiresAt: new Date(
        Date.now() + token.refresh_expires_in * 1000,
      ),
    },
    update: {
      country,
      sellerId: site?.seller_id ?? null,
      accessTokenEnc: encrypt(token.access_token),
      refreshTokenEnc: encrypt(token.refresh_token),
      tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
      refreshTokenExpiresAt: new Date(
        Date.now() + token.refresh_expires_in * 1000,
      ),
    },
  });

  const apiKey = process.env.SHOPIFY_API_KEY;
  return redirect(`https://${shop}/admin/apps/${apiKey}/app/daraz`);
};
