import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  EmptyState,
  Link,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { DARAZ_SITES, isDarazCountry } from "../daraz/countries";
import RevenueTrendChart from "../components/RevenueTrendChart";

const TREND_DAYS = 30;
const RECENT_ORDERS_LIMIT = 6;
const ATTENTION_LIMIT = 5;
const TOP_PRODUCTS_LIMIT = 5;

const PRODUCT_TITLES_QUERY = `#graphql
  query DashboardProductTitles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const account = await db.darazAccount.findUnique({
    where: { shop: session.shop },
  });

  if (!account) {
    return { connected: false as const };
  }

  const trendStart = new Date();
  trendStart.setDate(trendStart.getDate() - (TREND_DAYS - 1));
  trendStart.setHours(0, 0, 0, 0);

  // Sequential, not Promise.all: Supabase's pooled connection (pgbouncer,
  // transaction mode) doesn't reliably support multiple concurrent queries
  // from one Prisma client - running these in parallel intermittently threw
  // PrismaClientUnknownRequestError in production.
  const mappingCounts = await db.productMapping.groupBy({
    by: ["syncStatus"],
    where: { shop: session.shop },
    _count: true,
  });
  const pendingSyncJobs = await db.syncJob.count({
    where: { shop: session.shop, status: "pending" },
  });
  const orderCount = await db.darazOrder.count({ where: { shop: session.shop } });
  const errorMappings = await db.productMapping.findMany({
    where: { shop: session.shop, syncStatus: "error" },
    orderBy: { updatedAt: "desc" },
    take: ATTENTION_LIMIT,
  });
  const unmappedMappings = await db.productMapping.findMany({
    where: { shop: session.shop, syncStatus: "unmapped" },
    orderBy: { updatedAt: "desc" },
    take: ATTENTION_LIMIT,
  });
  const recentOrders = await db.darazOrder.findMany({
    where: { shop: session.shop },
    orderBy: [{ darazCreatedAt: "desc" }, { importedAt: "desc" }],
    take: RECENT_ORDERS_LIMIT,
  });
  const trendOrders = await db.darazOrder.findMany({
    where: { shop: session.shop, darazCreatedAt: { gte: trendStart } },
    select: { darazCreatedAt: true, totalAmount: true },
  });
  const orderItems = await db.darazOrderItem.findMany({
    where: { order: { shop: session.shop } },
    select: { sku: true, name: true, price: true },
  });

  const countByStatus = Object.fromEntries(
    mappingCounts.map((c) => [c.syncStatus, c._count]),
  ) as Partial<Record<string, number>>;

  // Confirm the flagged products still exist in Shopify and fetch their
  // titles in one batch, same pattern used to catch stale mappings on the
  // import page.
  const attentionProductIds = [...errorMappings, ...unmappedMappings].map(
    (m) => m.shopifyProductId,
  );
  const titleByProductId = new Map<string, string>();
  if (attentionProductIds.length > 0) {
    const gids = attentionProductIds.map((id) => `gid://shopify/Product/${id}`);
    const response = await admin.graphql(PRODUCT_TITLES_QUERY, { variables: { ids: gids } });
    const json = await response.json();
    for (const node of (json.data?.nodes ?? []) as Array<{ id: string; title: string } | null>) {
      if (node) titleByProductId.set(node.id.split("/").pop()!, node.title);
    }
  }

  const needsAttention = [
    ...errorMappings.map((m) => ({
      type: "error" as const,
      shopifyProductId: m.shopifyProductId,
      title: titleByProductId.get(m.shopifyProductId) ?? `Product ${m.shopifyProductId}`,
      detail: m.lastError ?? "Sync failed",
    })),
    ...unmappedMappings.map((m) => ({
      type: "unmapped" as const,
      shopifyProductId: m.shopifyProductId,
      title: titleByProductId.get(m.shopifyProductId) ?? `Product ${m.shopifyProductId}`,
      detail: "Needs a Daraz category mapping",
    })),
  ];

  // Zero-fill every day in the window so the trend line reflects real gaps
  // in order activity rather than skipping straight past them.
  const revenueByDay = new Map<string, number>();
  for (const order of trendOrders) {
    if (!order.darazCreatedAt) continue;
    const key = order.darazCreatedAt.toISOString().slice(0, 10);
    const amount = order.totalAmount ? Number(order.totalAmount) : 0;
    revenueByDay.set(key, (revenueByDay.get(key) ?? 0) + (Number.isFinite(amount) ? amount : 0));
  }
  const revenueTrend: Array<{ date: string; value: number }> = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    revenueTrend.push({ date: key, value: revenueByDay.get(key) ?? 0 });
  }
  const revenue30d = revenueTrend.reduce((sum, d) => sum + d.value, 0);

  const bySku = new Map<string, { name: string; count: number; revenue: number }>();
  for (const item of orderItems) {
    const key = item.sku ?? item.name ?? "unknown";
    const amount = item.price ? Number(item.price) : 0;
    const entry = bySku.get(key) ?? { name: item.name ?? key, count: 0, revenue: 0 };
    entry.count++;
    entry.revenue += Number.isFinite(amount) ? amount : 0;
    bySku.set(key, entry);
  }
  const topProducts = Array.from(bySku.entries())
    .map(([sku, v]) => ({ sku, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_PRODUCTS_LIMIT);

  return {
    connected: true as const,
    countryLabel: isDarazCountry(account.country)
      ? DARAZ_SITES[account.country].label
      : account.country,
    currency: isDarazCountry(account.country) ? DARAZ_SITES[account.country].currency : null,
    sellerId: account.sellerId,
    synced: countByStatus.synced ?? 0,
    pending: countByStatus.pending ?? 0,
    unmapped: countByStatus.unmapped ?? 0,
    error: countByStatus.error ?? 0,
    pendingSyncJobs,
    orderCount,
    revenue30d,
    needsAttention,
    recentOrders: recentOrders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber ?? o.darazOrderId,
      customerName: o.customerName,
      status: o.status,
      totalAmount: o.totalAmount,
      darazCreatedAt: o.darazCreatedAt,
    })),
    revenueTrend,
    topProducts,
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

export default function Index() {
  const data = useLoaderData<typeof loader>();

  if (!data.connected) {
    return (
      <Page>
        <TitleBar title="Daraz sync" />
        <Card>
          <EmptyState
            heading="Connect your Daraz seller account to get started"
            action={{ content: "Connect Daraz", url: "/app/daraz" }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>
              Once connected, you can import your existing Daraz catalog into
              Shopify, keep prices and stock in sync, and see Daraz orders in
              one place.
            </p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const money = (amount: string | number | null) => {
    if (amount === null) return "-";
    const n = typeof amount === "string" ? Number(amount) : amount;
    if (!Number.isFinite(n)) return "-";
    return `${n.toLocaleString()}${data.currency ? ` ${data.currency}` : ""}`;
  };

  return (
    <Page>
      <TitleBar title="Daraz sync" />
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Connected to Daraz {data.countryLabel}
              </Text>
              <Badge tone="success">Connected</Badge>
            </InlineStack>
            {data.sellerId && (
              <Text as="p" tone="subdued" variant="bodySm">
                Seller ID {data.sellerId}
              </Text>
            )}
            <InlineStack gap="200">
              <Button url="/app/daraz/products" variant="primary">
                Go to products
              </Button>
              <Button url="/app/daraz/import">Import from Daraz</Button>
              <Button url="/app/daraz/orders">Daraz orders</Button>
              <Button url="/app/daraz">Connection settings</Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {data.needsAttention.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Needs attention
              </Text>
              <BlockStack gap="200">
                {data.needsAttention.map((item) => (
                  <InlineStack key={item.shopifyProductId} align="space-between" blockAlign="center">
                    <BlockStack gap="0">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {item.title}
                        </Text>
                        <Badge tone={item.type === "error" ? "critical" : "attention"}>
                          {item.type === "error" ? "Sync error" : "Unmapped"}
                        </Badge>
                      </InlineStack>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {item.detail}
                      </Text>
                    </BlockStack>
                    <Button url={`/app/daraz/products/${item.shopifyProductId}`}>Fix</Button>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Products
                </Text>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">
                    Synced
                  </Text>
                  <Badge tone="success">{String(data.synced)}</Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">
                    Pending
                  </Text>
                  <Badge tone="info">{String(data.pending)}</Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">
                    Unmapped
                  </Text>
                  <Badge tone="attention">{String(data.unmapped)}</Badge>
                </InlineStack>
                {data.error > 0 && (
                  <InlineStack align="space-between">
                    <Text as="span" variant="bodyMd">
                      Errors
                    </Text>
                    <Badge tone="critical">{String(data.error)}</Badge>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Sync queue
                </Text>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">
                    Waiting to sync
                  </Text>
                  <Badge tone={data.pendingSyncJobs > 0 ? "attention" : "success"}>
                    {String(data.pendingSyncJobs)}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Changes to Shopify products enqueue here and are drained
                  on-demand from the products page.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Orders
                </Text>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">
                    Imported from Daraz
                  </Text>
                  <Badge>{String(data.orderCount)}</Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">
                    Last 30 days
                  </Text>
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {money(data.revenue30d)}
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Revenue - last 30 days
            </Text>
            {data.revenueTrend.some((d) => d.value > 0) ? (
              <RevenueTrendChart data={data.revenueTrend} currency={data.currency} />
            ) : (
              <Text as="p" tone="subdued" variant="bodyMd">
                No order activity in the last 30 days yet.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Recent orders
                  </Text>
                  <Link url="/app/daraz/orders">View all</Link>
                </InlineStack>
                {data.recentOrders.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodyMd">
                    No orders imported yet.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {data.recentOrders.map((order) => (
                      <InlineStack key={order.id} align="space-between" blockAlign="center">
                        <BlockStack gap="0">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {order.orderNumber}
                          </Text>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {order.customerName ?? "Unknown"}
                            {order.darazCreatedAt
                              ? ` · ${new Date(order.darazCreatedAt).toLocaleDateString()}`
                              : ""}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={statusTone(order.status)}>{order.status}</Badge>
                          <Text as="span" variant="bodyMd">
                            {money(order.totalAmount)}
                          </Text>
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Top products by orders
                </Text>
                {data.topProducts.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodyMd">
                    No order items yet.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {data.topProducts.map((product, index) => (
                      <InlineStack key={product.sku} align="space-between" blockAlign="center">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" tone="subdued" variant="bodySm">
                            {index + 1}.
                          </Text>
                          <Text as="span" variant="bodyMd">
                            {product.name}
                          </Text>
                        </InlineStack>
                        <Text as="span" tone="subdued" variant="bodySm">
                          {product.count} order(s) · {money(product.revenue)}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
