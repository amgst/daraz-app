import { useEffect } from "react";
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
  ResourceList,
  ResourceItem,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { importDarazOrders } from "../daraz/orders.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const darazAccount = await db.darazAccount.findUnique({
    where: { shop: session.shop },
  });
  if (!darazAccount) {
    return { connected: false as const, orders: [] };
  }

  const orders = await db.darazOrder.findMany({
    where: { shop: session.shop },
    include: { items: true },
    orderBy: [{ darazCreatedAt: "desc" }, { importedAt: "desc" }],
    take: 100,
  });

  return {
    connected: true as const,
    orders: orders.map((o) => ({
      id: o.id,
      darazOrderId: o.darazOrderId,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      status: o.status,
      itemsCount: o.itemsCount,
      totalAmount: o.totalAmount,
      currency: o.currency,
      darazCreatedAt: o.darazCreatedAt,
      itemNames: o.items.map((i) => i.name).filter((n): n is string => Boolean(n)),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const result = await importDarazOrders(session.shop);
    return { ok: true as const, ...result };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const STATUS_TONE: Record<string, "success" | "attention" | "critical" | "info"> = {
  delivered: "success",
  shipped: "info",
  pending: "attention",
  canceled: "critical",
  cancelled: "critical",
  returned: "critical",
};

export default function DarazOrders() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const isSyncing = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(
        `Synced orders: ${fetcher.data.imported} new, ${fetcher.data.updated} updated`,
      );
    } else {
      shopify.toast.show(fetcher.data.error ?? "Order sync failed", { isError: true });
    }
  }, [fetcher.data, shopify]);

  if (!data.connected) {
    return (
      <Page>
        <TitleBar title="Daraz orders" />
        <Card>
          <EmptyState
            heading="Connect Daraz first"
            action={{ content: "Go to connection page", url: "/app/daraz" }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>You need to connect a Daraz seller account before importing orders.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  return (
    <Page>
      <TitleBar title="Daraz orders" />
      <BlockStack gap="400">
        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodyMd">
              Orders shown here are imported from Daraz into this app only -
              they are not created as Shopify orders yet.
            </Text>
            <Button
              variant="primary"
              loading={isSyncing}
              onClick={() => fetcher.submit({}, { method: "POST" })}
            >
              Sync orders
            </Button>
          </InlineStack>
        </Card>
        <Card padding="0">
          {data.orders.length === 0 ? (
            <EmptyState
              heading="No orders imported yet"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Click "Sync orders" to pull recent orders from Daraz.</p>
            </EmptyState>
          ) : (
            <ResourceList
              resourceName={{ singular: "order", plural: "orders" }}
              items={data.orders}
              renderItem={(order) => (
                <ResourceItem id={order.id} onClick={() => {}}>
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {order.orderNumber ?? order.darazOrderId}
                        </Text>
                        <Badge tone={STATUS_TONE[order.status.toLowerCase()] ?? "info"}>
                          {order.status}
                        </Badge>
                      </InlineStack>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {order.customerName ?? "Unknown customer"} &middot;{" "}
                        {order.itemsCount} item(s)
                        {order.itemNames.length > 0 ? `: ${order.itemNames.join(", ")}` : ""}
                      </Text>
                    </BlockStack>
                    <BlockStack gap="100" align="end">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {order.totalAmount ? `${order.totalAmount} ${order.currency ?? ""}` : "-"}
                      </Text>
                      {order.darazCreatedAt && (
                        <Text as="span" tone="subdued" variant="bodySm">
                          {new Date(order.darazCreatedAt).toLocaleDateString()}
                        </Text>
                      )}
                    </BlockStack>
                  </InlineStack>
                </ResourceItem>
              )}
            />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
