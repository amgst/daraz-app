import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  Badge,
  Text,
  Button,
  EmptyState,
  InlineStack,
  BlockStack,
  IndexTable,
  TextField,
  Select,
  Pagination,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useToast } from "../components/ToastProvider";
import db from "../db.server";
import { importDarazOrders } from "../daraz/orders.server";
import { DARAZ_SITES, isDarazCountry } from "../daraz/countries";

const PAGE_SIZE = 20;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const darazAccount = await db.darazAccount.findUnique({
    where: { shop: session.shop },
  });
  if (!darazAccount) {
    return {
      connected: false as const,
      orders: [],
      statuses: [] as string[],
      stats: null,
      page: 1,
      totalCount: 0,
      hasNext: false,
      hasPrevious: false,
      status: "",
      q: "",
      currency: null as string | null,
    };
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "";
  const q = url.searchParams.get("q") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);

  const where = {
    shop: session.shop,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { orderNumber: { contains: q, mode: "insensitive" as const } },
            { darazOrderId: { contains: q, mode: "insensitive" as const } },
            { customerName: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [orders, totalCount, allForStats, distinctStatuses] = await Promise.all([
    db.darazOrder.findMany({
      where,
      include: { items: true },
      orderBy: [{ darazCreatedAt: "desc" }, { importedAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.darazOrder.count({ where }),
    db.darazOrder.findMany({
      where: { shop: session.shop },
      select: { status: true, totalAmount: true },
    }),
    db.darazOrder.findMany({
      where: { shop: session.shop },
      distinct: ["status"],
      select: { status: true },
    }),
  ]);

  const statsByStatus = new Map<string, { count: number; revenue: number }>();
  let totalRevenue = 0;
  for (const o of allForStats) {
    const amount = o.totalAmount ? Number(o.totalAmount) : 0;
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    totalRevenue += safeAmount;
    const entry = statsByStatus.get(o.status) ?? { count: 0, revenue: 0 };
    entry.count++;
    entry.revenue += safeAmount;
    statsByStatus.set(o.status, entry);
  }

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
      darazCreatedAt: o.darazCreatedAt,
      itemNames: o.items.map((i) => i.name).filter((n): n is string => Boolean(n)),
    })),
    statuses: distinctStatuses.map((s) => s.status).sort(),
    stats: {
      totalOrders: allForStats.length,
      totalRevenue,
      byStatus: Array.from(statsByStatus.entries())
        .map(([s, v]) => ({ status: s, ...v }))
        .sort((a, b) => b.count - a.count),
    },
    page,
    totalCount,
    hasNext: page * PAGE_SIZE < totalCount,
    hasPrevious: page > 1,
    status,
    q,
    currency: isDarazCountry(darazAccount.country) ? DARAZ_SITES[darazAccount.country].currency : null,
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

function statusTone(status: string) {
  return STATUS_TONE[status.toLowerCase()] ?? "info";
}

function buildUrl(params: Record<string, string | number>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== "" && value !== undefined && value !== null) {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export default function DarazOrders() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const toast = useToast();
  const navigate = useNavigate();

  const isSyncing = fetcher.state !== "idle";
  const [q, setQ] = useState(data.q);
  const [status, setStatus] = useState(data.status);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      toast.show(
        `Synced orders: ${fetcher.data.imported} new, ${fetcher.data.updated} updated`,
      );
    } else {
      toast.show(fetcher.data.error ?? "Order sync failed", { isError: true });
    }
  }, [fetcher.data, toast]);

  if (!data.connected) {
    return (
      <Page title="Daraz orders">
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

  const statusOptions = [
    { label: "All statuses", value: "" },
    ...data.statuses.map((s) => ({ label: s, value: s })),
  ];

  const money = (amount: string | number | null) => {
    if (amount === null) return "-";
    const n = typeof amount === "string" ? Number(amount) : amount;
    if (!Number.isFinite(n)) return "-";
    return `${n.toLocaleString()}${data.currency ? ` ${data.currency}` : ""}`;
  };

  return (
    <Page title="Daraz orders">
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

        {data.stats && (
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="600">
                <BlockStack gap="050">
                  <Text as="span" tone="subdued" variant="bodySm">
                    Total orders
                  </Text>
                  <Text as="span" variant="headingLg">
                    {data.stats.totalOrders}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="span" tone="subdued" variant="bodySm">
                    Total value
                  </Text>
                  <Text as="span" variant="headingLg">
                    {money(data.stats.totalRevenue)}
                  </Text>
                </BlockStack>
              </InlineStack>
              <InlineStack gap="200">
                {data.stats.byStatus.map((s) => (
                  <Badge key={s.status} tone={statusTone(s.status)}>
                    {`${s.status}: ${s.count}`}
                  </Badge>
                ))}
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        <Card>
          <Form method="get">
            <InlineStack gap="300" blockAlign="end">
              <div style={{ minWidth: 260 }}>
                <TextField
                  label="Search"
                  name="q"
                  autoComplete="off"
                  value={q}
                  onChange={setQ}
                  placeholder="Order number or customer name"
                />
              </div>
              <div style={{ minWidth: 220 }}>
                <Select label="Status" name="status" options={statusOptions} value={status} onChange={setStatus} />
              </div>
              <Button submit>Filter</Button>
              {(data.status || data.q) && (
                <Button variant="plain" onClick={() => navigate("/app/daraz/orders")}>
                  Clear
                </Button>
              )}
            </InlineStack>
          </Form>
        </Card>

        <Card padding="0">
          {data.orders.length === 0 ? (
            <EmptyState
              heading="No orders found"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                {data.status || data.q
                  ? "No orders match this filter."
                  : 'Click "Sync orders" to pull orders from Daraz.'}
              </p>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={{ singular: "order", plural: "orders" }}
              itemCount={data.orders.length}
              selectable={false}
              headings={[
                { title: "Order" },
                { title: "Customer" },
                { title: "Status" },
                { title: "Items" },
                { title: "Total" },
                { title: "Date" },
              ]}
            >
              {data.orders.map((order, index) => (
                <IndexTable.Row
                  id={order.id}
                  key={order.id}
                  position={index}
                  onClick={() => navigate(`/app/daraz/orders/${order.id}`)}
                >
                  <IndexTable.Cell>
                    <Text as="span" fontWeight="semibold">
                      {order.orderNumber ?? order.darazOrderId}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{order.customerName ?? "Unknown"}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={statusTone(order.status)}>{order.status}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" tone="subdued">
                      {order.itemsCount} item(s)
                      {order.itemNames.length > 0 ? `: ${order.itemNames.join(", ")}` : ""}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{money(order.totalAmount)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {order.darazCreatedAt
                      ? new Date(order.darazCreatedAt).toLocaleDateString()
                      : "-"}
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>

        {(data.hasNext || data.hasPrevious) && (
          <InlineStack align="center">
            <Pagination
              hasPrevious={data.hasPrevious}
              onPrevious={() =>
                navigate(
                  `/app/daraz/orders${buildUrl({ status: data.status, q: data.q, page: data.page - 1 })}`,
                )
              }
              hasNext={data.hasNext}
              onNext={() =>
                navigate(
                  `/app/daraz/orders${buildUrl({ status: data.status, q: data.q, page: data.page + 1 })}`,
                )
              }
            />
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
}
