import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  Badge,
  Text,
  Button,
  EmptyState,
  InlineStack,
  ResourceList,
  ResourceItem,
  Thumbnail,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  syncProduct,
  clearPendingSyncJobs,
  drainPendingSyncJobs,
  pullPriceStockFromDaraz,
} from "../daraz/sync.server";

const PRODUCTS_QUERY = `#graphql
  query DarazProductsList {
    products(first: 50, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        featuredImage { url altText }
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const darazAccount = await db.darazAccount.findUnique({
    where: { shop: session.shop },
  });
  if (!darazAccount) {
    return { connected: false as const, products: [] };
  }

  const response = await admin.graphql(PRODUCTS_QUERY);
  const json = await response.json();
  const shopifyProducts = (json.data?.products.nodes ?? []) as Array<{
    id: string;
    title: string;
    featuredImage: { url: string; altText: string | null } | null;
  }>;

  const mappings = await db.productMapping.findMany({
    where: { shop: session.shop },
  });
  const mappingByProductId = new Map(
    mappings.map((m) => [m.shopifyProductId, m]),
  );

  const products = shopifyProducts.map((p) => {
    const numericId = p.id.split("/").pop()!;
    const mapping = mappingByProductId.get(numericId);
    return {
      id: numericId,
      gid: p.id,
      title: p.title,
      imageUrl: p.featuredImage?.url ?? null,
      syncStatus: mapping?.syncStatus ?? "unmapped",
      darazItemId: mapping?.darazItemId ?? null,
      lastError: mapping?.lastError ?? null,
    };
  });

  const pendingCount = await db.syncJob.count({
    where: { shop: session.shop, status: "pending" },
  });

  return { connected: true as const, products, pendingCount };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "syncAll") {
    const processed = await drainPendingSyncJobs(session.shop);
    return { intent: "syncAll" as const, processed };
  }

  if (formData.get("intent") === "pullFromDaraz") {
    const result = await pullPriceStockFromDaraz(session.shop);
    return { intent: "pullFromDaraz" as const, ...result };
  }

  const productId = String(formData.get("productId"));

  try {
    const mapping = await db.productMapping.findUnique({
      where: {
        shop_shopifyProductId: { shop: session.shop, shopifyProductId: productId },
      },
    });
    await syncProduct(
      session.shop,
      productId,
      mapping?.darazItemId ? "update" : "create",
    );
    await clearPendingSyncJobs(session.shop, productId);
    return { intent: "single" as const, productId, ok: true as const };
  } catch (error) {
    return {
      intent: "single" as const,
      productId,
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const STATUS_TONE: Record<string, "success" | "attention" | "critical" | "info"> = {
  synced: "success",
  pending: "info",
  unmapped: "attention",
  error: "critical",
};

export default function DarazProducts() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.intent === "syncAll") {
      shopify.toast.show(`Synced ${fetcher.data.processed} pending product(s)`);
    } else if (fetcher.data.intent === "pullFromDaraz") {
      const { productsChecked, productsUpdated, errors } = fetcher.data;
      shopify.toast.show(
        `Checked ${productsChecked} product(s) on Daraz, updated ${productsUpdated} with new price/stock`,
        { isError: errors.length > 0 },
      );
    } else if (fetcher.data.ok) {
      shopify.toast.show("Synced to Daraz");
    } else {
      shopify.toast.show(fetcher.data.error ?? "Sync failed", { isError: true });
    }
  }, [fetcher.data, shopify]);

  if (!data.connected) {
    return (
      <Page>
        <TitleBar title="Daraz products" />
        <Card>
          <EmptyState
            heading="Connect Daraz first"
            action={{ content: "Go to connection page", url: "/app/daraz" }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>You need to connect a Daraz seller account before syncing products.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const isSyncingAll =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "syncAll";
  const isPullingFromDaraz =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "pullFromDaraz";
  const syncingProductId =
    fetcher.state !== "idle" && !fetcher.formData?.get("intent")
      ? String(fetcher.formData?.get("productId"))
      : null;

  return (
    <Page>
      <TitleBar title="Daraz products" />
      <div style={{ marginBottom: "1rem" }}>
        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodyMd">
              Price and stock are owned by Daraz - check for changes made
              directly in Daraz's seller center and pull them into Shopify.
            </Text>
            <Button
              loading={isPullingFromDaraz}
              onClick={() =>
                fetcher.submit({ intent: "pullFromDaraz" }, { method: "POST" })
              }
            >
              Check Daraz for updates
            </Button>
          </InlineStack>
        </Card>
      </div>
      {data.pendingCount > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodyMd">
                {data.pendingCount} product(s) have changes waiting to sync.
                There's no automatic background sync on this plan - drain them
                on demand, or sync individual products below.
              </Text>
              <Button
                variant="primary"
                loading={isSyncingAll}
                onClick={() =>
                  fetcher.submit({ intent: "syncAll" }, { method: "POST" })
                }
              >
                Sync all pending
              </Button>
            </InlineStack>
          </Card>
        </div>
      )}
      <Card padding="0">
        <ResourceList
          resourceName={{ singular: "product", plural: "products" }}
          items={data.products}
          renderItem={(product) => {
            const isSyncingThis = syncingProductId === product.id;
            return (
              <ResourceItem
                id={product.id}
                onClick={() => {
                  console.log("[Daraz products] ResourceItem clicked, navigating to", `/app/daraz/products/${product.id}`);
                  navigate(`/app/daraz/products/${product.id}`);
                }}
                media={
                  <Thumbnail
                    source={product.imageUrl || ""}
                    alt={product.title}
                    size="small"
                  />
                }
                accessibilityLabel={`Map or sync ${product.title}`}
                shortcutActions={[
                  {
                    content:
                      product.syncStatus === "unmapped" ? "Map category" : "Edit mapping",
                    onAction: () => {
                      console.log("[Daraz products] shortcut action clicked, navigating to", `/app/daraz/products/${product.id}`);
                      navigate(`/app/daraz/products/${product.id}`);
                    },
                  },
                  {
                    content: isSyncingThis ? "Syncing..." : "Sync now",
                    disabled: product.syncStatus === "unmapped" || isSyncingThis,
                    onAction: () =>
                      fetcher.submit({ productId: product.id }, { method: "POST" }),
                  },
                ]}
              >
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {product.title}
                  </Text>
                  <Badge tone={STATUS_TONE[product.syncStatus]}>
                    {product.syncStatus}
                  </Badge>
                  {product.darazItemId && (
                    <Text as="span" tone="subdued" variant="bodySm">
                      Daraz item {product.darazItemId}
                    </Text>
                  )}
                </InlineStack>
              </ResourceItem>
            );
          }}
        />
      </Card>
    </Page>
  );
}
