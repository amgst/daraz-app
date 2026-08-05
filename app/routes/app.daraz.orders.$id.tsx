import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  ResourceList,
  ResourceItem,
  Thumbnail,
  EmptyState,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { DARAZ_SITES, isDarazCountry } from "../daraz/countries";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const darazAccount = await db.darazAccount.findUnique({
    where: { shop: session.shop },
  });

  const order = await db.darazOrder.findUnique({
    where: { id: params.id },
    include: { items: true },
  });

  // Scope to this shop's own data - a valid order id belonging to a
  // different shop must not be viewable here.
  if (!order || order.shop !== session.shop) {
    return { found: false as const };
  }

  return {
    found: true as const,
    order: {
      id: order.id,
      darazOrderId: order.darazOrderId,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      status: order.status,
      itemsCount: order.itemsCount,
      totalAmount: order.totalAmount,
      darazCreatedAt: order.darazCreatedAt,
      darazUpdatedAt: order.darazUpdatedAt,
      importedAt: order.importedAt,
      items: order.items.map((i) => ({
        id: i.id,
        darazOrderItemId: i.darazOrderItemId,
        sku: i.sku,
        name: i.name,
        imageUrl: i.imageUrl,
        price: i.price,
        status: i.status,
      })),
    },
    currency:
      darazAccount && isDarazCountry(darazAccount.country)
        ? DARAZ_SITES[darazAccount.country].currency
        : null,
  };
};

const STATUS_TONE: Record<string, "success" | "attention" | "critical" | "info"> = {
  delivered: "success",
  shipped: "info",
  pending: "attention",
  canceled: "critical",
  cancelled: "critical",
  returned: "critical",
};

function statusTone(status: string) {
  return STATUS_TONE[status.toLowerCase()] ?? "info";
}

export default function DarazOrderDetail() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  if (!data.found) {
    return (
      <Page title="Order not found">
        <Card>
          <EmptyState
            heading="Order not found"
            action={{ content: "Back to orders", onAction: () => navigate("/app/daraz/orders") }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>This order doesn't exist or isn't part of this store's Daraz account.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const { order, currency } = data;
  const money = (amount: string | null) => {
    if (!amount) return "-";
    const n = Number(amount);
    if (!Number.isFinite(n)) return amount;
    return `${n.toLocaleString()}${currency ? ` ${currency}` : ""}`;
  };

  return (
    <Page
      backAction={{ content: "Orders", onAction: () => navigate("/app/daraz/orders") }}
      title={`Order ${order.orderNumber ?? order.darazOrderId}`}
    >
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                {order.orderNumber ?? order.darazOrderId}
              </Text>
              <Badge tone={statusTone(order.status)}>{order.status}</Badge>
            </InlineStack>
            <InlineStack gap="600">
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">
                  Customer
                </Text>
                <Text as="span" variant="bodyMd">
                  {order.customerName ?? "Unknown"}
                </Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">
                  Total
                </Text>
                <Text as="span" variant="bodyMd">
                  {money(order.totalAmount)}
                </Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">
                  Daraz order ID
                </Text>
                <Text as="span" variant="bodyMd">
                  {order.darazOrderId}
                </Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">
                  Order date
                </Text>
                <Text as="span" variant="bodyMd">
                  {order.darazCreatedAt ? new Date(order.darazCreatedAt).toLocaleString() : "-"}
                </Text>
              </BlockStack>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card padding="0">
          <ResourceList
            resourceName={{ singular: "item", plural: "items" }}
            items={order.items}
            renderItem={(item) => (
              <ResourceItem
                id={item.id}
                onClick={() => {}}
                media={<Thumbnail source={item.imageUrl || ""} alt={item.name ?? "Item"} size="small" />}
              >
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {item.name ?? "Unnamed item"}
                    </Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {item.sku ?? "No SKU"}
                      {item.status ? ` · ${item.status}` : ""}
                    </Text>
                  </BlockStack>
                  <Text as="span" variant="bodyMd">
                    {money(item.price)}
                  </Text>
                </InlineStack>
              </ResourceItem>
            )}
          />
        </Card>
      </BlockStack>
    </Page>
  );
}
