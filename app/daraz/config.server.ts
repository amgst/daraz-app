// Daraz Open Platform runs one API gateway host per country site - both the
// REST API (under /rest) and the OAuth authorize/login page (under /oauth)
// live on that same host. There is no separate global auth host (an earlier
// guess of "auth.daraz.com" turned out to be wrong - NXDOMAIN). Since the
// country isn't known until after OAuth completes, the merchant picks it
// upfront on the connect page and it travels through the signed `state`
// param so the callback knows which host to exchange the code against.
export const DARAZ_SITES = {
  PK: { label: "Pakistan", host: "https://api.daraz.pk" },
  BD: { label: "Bangladesh", host: "https://api.daraz.com.bd" },
  LK: { label: "Sri Lanka", host: "https://api.daraz.lk" },
  NP: { label: "Nepal", host: "https://api.daraz.com.np" },
  MM: { label: "Myanmar", host: "https://api.shop.com.mm" },
} as const;

export type DarazCountry = keyof typeof DARAZ_SITES;

export function isDarazCountry(value: string): value is DarazCountry {
  return value in DARAZ_SITES;
}

function hostFor(country: string): string {
  if (!isDarazCountry(country)) {
    throw new Error(`Unknown Daraz country/site: ${country}`);
  }
  return DARAZ_SITES[country].host;
}

export function apiHostFor(country: string): string {
  return `${hostFor(country)}/rest`;
}

export function oauthHostFor(country: string): string {
  return hostFor(country);
}

export function getDarazAppCredentials() {
  const appKey = process.env.DARAZ_APP_KEY;
  const appSecret = process.env.DARAZ_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error(
      "DARAZ_APP_KEY / DARAZ_APP_SECRET environment variables are not set",
    );
  }
  return { appKey, appSecret };
}

export function getDarazRedirectUri(): string {
  const redirectUri = process.env.DARAZ_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error("DARAZ_REDIRECT_URI environment variable is not set");
  }
  return redirectUri;
}
