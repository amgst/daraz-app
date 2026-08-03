// Plain data, safe to import from client-rendered route components (unlike
// config.server.ts, which also holds secrets/env access and gets stripped
// from the client bundle by Remix).
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
