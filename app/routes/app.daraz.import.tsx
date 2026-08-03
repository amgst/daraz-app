import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Badge,
  Text,
  Button,
  EmptyState,
  InlineStack,
  BlockStack,
  TextField,
  ResourceList,
  ResourceItem,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getValidAccessToken } from "../daraz/tokens.server";
import { getProducts, getRawProductDetail } from "../daraz/client.server";
import { importDarazProduct } from "../daraz/sync.server";

const PAGE_SIZE = 20;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const darazAccount = await db.darazAccount.findUnique({
    where: { shop: session.shop },
  });
  if (!darazAccount) {
    return { connected: false as const, products: [], offset: 0, hasMore: false };
  }

  const url = new URL(request.url);
  const offset = Number(url.searchParams.get("offset") ?? "0") || 0;

  const darazSession = await getValidAccessToken(session.shop);
  if (!darazSession) {
    return { connected: false as const, products: [], offset: 0, hasMore: false };
  }

  const darazProducts = await getProducts(
    { accessToken: darazSession.accessToken, country: darazSession.country },
    { limit: PAGE_SIZE, offset },
  );

  const linkedItemIds = new Set(
    (
      await db.productMapping.findMany({
        where: { shop: session.shop, darazItemId: { not: null } },
        select: { darazItemId: true },
      })
    ).map((m) => m.darazItemId),
  );

  const products = darazProducts.map((p) => ({
    itemId: p.item_id,
    name: p.attributes?.name ?? `Daraz item ${p.item_id}`,
    skuCount: p.skus.length,
    alreadyInShopify: linkedItemIds.has(p.item_id),
  }));

  return {
    connected: true as const,
    products,
    offset,
    hasMore: darazProducts.length === PAGE_SIZE,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "debugRaw") {
    const itemId = String(formData.get("itemId") ?? "");
    try {
      const darazSession = await getValidAccessToken(session.shop);
      if (!darazSession) {
        return { intent: "debugRaw" as const, raw: null, error: "Not connected to Daraz" };
      }
      const raw = await getRawProductDetail(
        { accessToken: darazSession.accessToken, country: darazSession.country },
        itemId,
      );
      return { intent: "debugRaw" as const, raw: JSON.stringify(raw, null, 2), error: null };
    } catch (error) {
      return {
        intent: "debugRaw" as const,
        raw: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const itemId = String(formData.get("itemId") ?? "");

  try {
    const shopifyProductId = await importDarazProduct(session.shop, itemId);
    return { intent: "import" as const, itemId, ok: true as const, shopifyProductId };
  } catch (error) {
    return {
      intent: "import" as const,
      itemId,
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export default function ImportFromDaraz() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const debugFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [debugItemId, setDebugItemId] = useState("");

  useEffect(() => {
    if (!fetcher.data || fetcher.data.intent !== "import") return;
    if (fetcher.data.ok) {
      shopify.toast.show("Imported to Shopify");
    } else {
      shopify.toast.show(fetcher.data.error ?? "Import failed", { isError: true });
    }
  }, [fetcher.data, shopify]);

  const rawResult = debugFetcher.data?.intent === "debugRaw" ? debugFetcher.data : null;
  const isFetchingRaw = debugFetcher.state !== "idle";

  if (!data.connected) {
    return (
      <Page>
        <TitleBar title="Import from Daraz" />
        <Card>
          <EmptyState
            heading="Connect Daraz first"
            action={{ content: "Go to connection page", url: "/app/daraz" }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>You need to connect a Daraz seller account before importing products.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const importingItemId =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("itemId")) : null;

  return (
    <Page>
      <TitleBar title="Import from Daraz" />
      <div style={{ marginBottom: "1rem" }}>
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Inspect raw Daraz data
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Temporary debug tool - shows exactly what Daraz returns for an
              item, to pin down real field names (e.g. where images live)
              instead of guessing.
            </Text>
            <InlineStack gap="200" blockAlign="end">
              <div style={{ minWidth: 240 }}>
                <TextField
                  label="Daraz item ID"
                  labelHidden
                  placeholder="e.g. 275503673"
                  value={debugItemId}
                  onChange={setDebugItemId}
                  autoComplete="off"
                />
              </div>
              <Button
                loading={isFetchingRaw}
                disabled={!debugItemId}
                onClick={() =>
                  debugFetcher.submit(
                    { intent: "debugRaw", itemId: debugItemId },
                    { method: "POST" },
                  )
                }
              >
                Show raw data
              </Button>
            </InlineStack>
            {rawResult?.error && (
              <Text as="p" tone="critical" variant="bodySm">
                {rawResult.error}
              </Text>
            )}
            {rawResult?.raw && (
              <div
                style={{
                  maxHeight: 400,
                  overflow: "auto",
                  background: "var(--p-color-bg-surface-secondary)",
                  padding: "1rem",
                  borderRadius: 8,
                }}
              >
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>
                  {rawResult.raw}
                </pre>
              </div>
            )}
          </BlockStack>
        </Card>
      </div>
      <Card padding="0">
        <ResourceList
          resourceName={{ singular: "Daraz product", plural: "Daraz products" }}
          items={data.products}
          renderItem={(product) => (
            <ResourceItem id={product.itemId} onClick={() => undefined}>
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {product.name}
                  </Text>
                  <Text as="span" tone="subdued" variant="bodySm">
                    Item {product.itemId} · {product.skuCount} SKU(s)
                  </Text>
                  {product.alreadyInShopify && <Badge tone="success">Already in Shopify</Badge>}
                </InlineStack>
                <Button
                  variant="primary"
                  disabled={product.alreadyInShopify}
                  loading={importingItemId === product.itemId}
                  onClick={() =>
                    fetcher.submit({ itemId: product.itemId }, { method: "POST" })
                  }
                >
                  Import to Shopify
                </Button>
              </InlineStack>
            </ResourceItem>
          )}
        />
      </Card>
      <div style={{ marginTop: "1rem" }}>
        <InlineStack gap="200">
          {data.offset > 0 && (
            <Button url={`/app/daraz/import?offset=${Math.max(0, data.offset - PAGE_SIZE)}`}>
              Previous
            </Button>
          )}
          {data.hasMore && (
            <Button url={`/app/daraz/import?offset=${data.offset + PAGE_SIZE}`}>
              Next
            </Button>
          )}
        </InlineStack>
      </div>
    </Page>
  );
}
