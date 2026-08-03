import db from "../db.server";
import { decrypt, encrypt } from "./crypto.server";
import { refreshAccessToken } from "./client.server";

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

export interface DarazSession {
  accessToken: string;
  country: string;
  sellerId: string | null;
}

// Returns a usable Daraz access token for the shop, transparently refreshing
// (and re-persisting, re-encrypted) it if it's within 5 minutes of expiry.
export async function getValidAccessToken(
  shop: string,
): Promise<DarazSession | null> {
  const account = await db.darazAccount.findUnique({ where: { shop } });
  if (!account) return null;

  if (account.tokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
    return {
      accessToken: decrypt(account.accessTokenEnc),
      country: account.country,
      sellerId: account.sellerId,
    };
  }

  if (account.refreshTokenExpiresAt.getTime() <= Date.now()) {
    throw new Error(
      `Daraz refresh token expired for shop ${shop} - merchant must reconnect`,
    );
  }

  const refreshToken = decrypt(account.refreshTokenEnc);
  const refreshed = await refreshAccessToken(refreshToken);

  await db.darazAccount.update({
    where: { shop },
    data: {
      accessTokenEnc: encrypt(refreshed.access_token),
      refreshTokenEnc: encrypt(refreshed.refresh_token),
      tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      refreshTokenExpiresAt: new Date(
        Date.now() + refreshed.refresh_expires_in * 1000,
      ),
    },
  });

  return {
    accessToken: refreshed.access_token,
    country: account.country,
    sellerId: account.sellerId,
  };
}
