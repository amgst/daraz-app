import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { InlineStack } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";
import { ToastProvider } from "../components/ToastProvider";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp={false} apiKey={apiKey}>
      <ToastProvider>
        <div style={{ padding: "1rem 1rem 0" }}>
          <InlineStack gap="400">
            <Link to="/app" rel="home">
              Home
            </Link>
            <Link to="/app/daraz">Daraz connection</Link>
            <Link to="/app/daraz/products">Daraz products</Link>
            <Link to="/app/daraz/import">Import from Daraz</Link>
            <Link to="/app/daraz/orders">Daraz orders</Link>
          </InlineStack>
        </div>
        <Outlet />
      </ToastProvider>
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
