// Daraz Open Platform runs a separate API gateway and auth host per country
// site. The seller picks/confirms their site during connect; everything
// after that is routed off DarazAccount.country.
export const DARAZ_SITES = {
  PK: { label: "Pakistan", apiHost: "https://api.daraz.pk/rest" },
  BD: { label: "Bangladesh", apiHost: "https://api.daraz.com.bd/rest" },
  LK: { label: "Sri Lanka", apiHost: "https://api.daraz.lk/rest" },
  NP: { label: "Nepal", apiHost: "https://api.daraz.com.np/rest" },
  MM: { label: "Myanmar", apiHost: "https://api.daraz.com.mm/rest" },
} as const;

export type DarazCountry = keyof typeof DARAZ_SITES;

export function isDarazCountry(value: string): value is DarazCountry {
  return value in DARAZ_SITES;
}

export function apiHostFor(country: string): string {
  if (!isDarazCountry(country)) {
    throw new Error(`Unknown Daraz country/site: ${country}`);
  }
  return DARAZ_SITES[country].apiHost;
}

// Authorization (login/consent) is served from a single global host,
// independent of the seller's country site.
export const DARAZ_AUTH_HOST = "https://auth.daraz.com";

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
