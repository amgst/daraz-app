import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  Text,
  Divider,
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useToast } from "../components/ToastProvider";
import db from "../db.server";
import { getValidAccessToken } from "../daraz/tokens.server";
import {
  getCategoryAttributes,
  getCategoryTree,
  getProducts,
  type DarazCategoryNode,
  type DarazExistingProduct,
} from "../daraz/client.server";
import { syncProduct, clearPendingSyncJobs } from "../daraz/sync.server";

const PRODUCT_TITLE_QUERY = `#graphql
  query DarazMappingProductTitle($id: ID!) {
    product(id: $id) {
      title
      variants(first: 1) { nodes { sku } }
    }
  }
`;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  console.log("[Daraz mapping] loader start, params.id =", params.id);
  try {
    const { admin, session } = await authenticate.admin(request);
    const productId = params.id!;
    console.log("[Daraz mapping] authenticated, shop =", session.shop, "productId =", productId);

    const response = await admin.graphql(PRODUCT_TITLE_QUERY, {
      variables: { id: `gid://shopify/Product/${productId}` },
    });
    const json = await response.json();
    const graphqlErrors = (json as { errors?: unknown }).errors;
    if (graphqlErrors) {
      console.error("[Daraz mapping] Shopify GraphQL errors:", JSON.stringify(graphqlErrors));
    }
    const title = json.data?.product?.title ?? "Unknown product";
    const defaultSku = json.data?.product?.variants?.nodes?.[0]?.sku ?? "";
    console.log("[Daraz mapping] product title =", title);

    const mapping = await db.productMapping.findUnique({
      where: {
        shop_shopifyProductId: { shop: session.shop, shopifyProductId: productId },
      },
    });
    console.log("[Daraz mapping] existing mapping =", JSON.stringify(mapping));

    return {
      productId,
      title,
      defaultSku,
      darazItemId: mapping?.darazItemId ?? null,
      categoryId: mapping?.darazCategoryId ?? "",
      attributes: mapping?.attributesJson
        ? (JSON.parse(mapping.attributesJson) as Record<string, string>)
        : {},
    };
  } catch (error) {
    console.error("[Daraz mapping] loader threw:", error);
    throw error;
  }
};

// Best-effort: Daraz's attribute-schema response shape is unverified against
// the live docs, so a parse failure here just means no suggestions - it
// never blocks the merchant from typing attributes in manually.
async function suggestAttributeNames(
  shop: string,
  categoryId: string,
): Promise<string[]> {
  try {
    const session = await getValidAccessToken(shop);
    if (!session) return [];
    const result = (await getCategoryAttributes(
      { accessToken: session.accessToken, country: session.country },
      categoryId,
    )) as { data?: { attributes?: Array<{ name?: string }> } };
    const names = result.data?.attributes
      ?.map((a) => a.name)
      .filter((n): n is string => Boolean(n));
    return names ?? [];
  } catch {
    return [];
  }
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const productId = params.id!;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "loadAttributes") {
    const categoryId = String(formData.get("categoryId") ?? "");
    const suggestions = await suggestAttributeNames(session.shop, categoryId);
    return { intent: "loadAttributes" as const, suggestions };
  }

  // Fetched on demand (not in the loader) - Daraz's full nested category
  // tree is large enough that fetching it eagerly on every page visit was
  // slow enough to feel like the page just wasn't loading.
  if (intent === "loadCategoryTree") {
    try {
      const darazSession = await getValidAccessToken(session.shop);
      if (!darazSession) {
        return { intent: "loadCategoryTree" as const, categoryTree: [] as DarazCategoryNode[], error: "Not connected to Daraz" };
      }
      const categoryTree = await getCategoryTree({
        accessToken: darazSession.accessToken,
        country: darazSession.country,
      });
      return { intent: "loadCategoryTree" as const, categoryTree, error: null };
    } catch (error) {
      return {
        intent: "loadCategoryTree" as const,
        categoryTree: [] as DarazCategoryNode[],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (intent === "searchDaraz") {
    const query = String(formData.get("query") ?? "").trim();
    if (!query) {
      return { intent: "searchDaraz" as const, results: [] as DarazExistingProduct[], error: null };
    }
    try {
      const darazSession = await getValidAccessToken(session.shop);
      if (!darazSession) {
        return {
          intent: "searchDaraz" as const,
          results: [] as DarazExistingProduct[],
          error: "Not connected to Daraz",
        };
      }
      const results = await getProducts(
        { accessToken: darazSession.accessToken, country: darazSession.country },
        { search: query },
      );
      return { intent: "searchDaraz" as const, results, error: null };
    } catch (error) {
      return {
        intent: "searchDaraz" as const,
        results: [] as DarazExistingProduct[],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (intent === "link") {
    const itemId = String(formData.get("itemId") ?? "");
    const linkCategoryId = String(formData.get("linkCategoryId") ?? "");
    const skuId = String(formData.get("skuId") ?? "");

    await db.productMapping.upsert({
      where: {
        shop_shopifyProductId: { shop: session.shop, shopifyProductId: productId },
      },
      create: {
        shop: session.shop,
        shopifyProductId: productId,
        darazItemId: itemId,
        darazSkuId: skuId || null,
        darazCategoryId: linkCategoryId || null,
        syncStatus: "synced",
        lastSyncedAt: new Date(),
      },
      update: {
        darazItemId: itemId,
        darazSkuId: skuId || null,
        darazCategoryId: linkCategoryId || null,
        syncStatus: "synced",
        lastSyncedAt: new Date(),
        lastError: null,
      },
    });
    await clearPendingSyncJobs(session.shop, productId);
    return { intent: "link" as const, ok: true as const };
  }

  const categoryId = String(formData.get("categoryId") ?? "");
  const attributesJson = String(formData.get("attributesJson") ?? "{}");

  await db.productMapping.upsert({
    where: {
      shop_shopifyProductId: { shop: session.shop, shopifyProductId: productId },
    },
    create: {
      shop: session.shop,
      shopifyProductId: productId,
      darazCategoryId: categoryId,
      attributesJson,
      syncStatus: "pending",
    },
    update: {
      darazCategoryId: categoryId,
      attributesJson,
      syncStatus: "pending",
      lastError: null,
    },
  });

  if (intent === "saveAndSync") {
    try {
      const existing = await db.productMapping.findUnique({
        where: {
          shop_shopifyProductId: { shop: session.shop, shopifyProductId: productId },
        },
      });
      await syncProduct(
        session.shop,
        productId,
        existing?.darazItemId ? "update" : "create",
      );
      await clearPendingSyncJobs(session.shop, productId);
      return { intent: "save" as const, ok: true as const };
    } catch (error) {
      return {
        intent: "save" as const,
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { intent: "save" as const, ok: true as const };
};

function findCategoryPath(
  tree: DarazCategoryNode[],
  targetId: string,
): DarazCategoryNode[] | null {
  for (const node of tree) {
    if (node.id === targetId) return [node];
    const childPath = findCategoryPath(node.children, targetId);
    if (childPath) return [node, ...childPath];
  }
  return null;
}

export default function ProductMappingPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const linkFetcher = useFetcher<typeof action>();
  const categoryFetcher = useFetcher<typeof action>();
  const toast = useToast();

  const [query, setQuery] = useState(data.defaultSku);
  const [categoryId, setCategoryId] = useState(data.categoryId);
  const [categoryTree, setCategoryTree] = useState<DarazCategoryNode[]>([]);
  const [categoryPath, setCategoryPath] = useState<DarazCategoryNode[]>([]);

  useEffect(() => {
    if (categoryFetcher.data?.intent !== "loadCategoryTree") return;
    if (categoryFetcher.data.error) {
      toast.show(categoryFetcher.data.error, { isError: true });
    }
    setCategoryTree(categoryFetcher.data.categoryTree);
    setCategoryPath(findCategoryPath(categoryFetcher.data.categoryTree, categoryId) ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryFetcher.data]);

  const isLoadingCategories = categoryFetcher.state !== "idle";
  const loadCategoryTree = () =>
    categoryFetcher.submit({ intent: "loadCategoryTree" }, { method: "POST" });

  const selectCategoryAtLevel = (level: number, id: string) => {
    const options = level === 0 ? categoryTree : categoryPath[level - 1].children;
    const node = options.find((n) => n.id === id);
    if (!node) return;
    const newPath = [...categoryPath.slice(0, level), node];
    setCategoryPath(newPath);
    setCategoryId(node.isLeaf ? node.id : "");
  };
  const [pairs, setPairs] = useState<Array<{ key: string; value: string }>>(
    Object.entries(data.attributes).map(([key, value]) => ({ key, value })),
  );

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.intent === "loadAttributes") {
      const existingKeys = new Set(pairs.map((p) => p.key));
      const newPairs = fetcher.data.suggestions
        .filter((name) => !existingKeys.has(name))
        .map((name) => ({ key: name, value: "" }));
      if (newPairs.length === 0) {
        toast.show("No attribute suggestions available - add manually");
      } else {
        setPairs((prev) => [...prev, ...newPairs]);
      }
    } else if (fetcher.data.intent === "save") {
      if (fetcher.data.ok) {
        toast.show("Mapping saved");
      } else {
        toast.show(fetcher.data.error ?? "Save failed", { isError: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  useEffect(() => {
    if (!linkFetcher.data) return;
    if (linkFetcher.data.intent === "searchDaraz" && linkFetcher.data.error) {
      toast.show(linkFetcher.data.error, { isError: true });
    }
    if (linkFetcher.data.intent === "link" && linkFetcher.data.ok) {
      toast.show("Linked to existing Daraz product");
    }
  }, [linkFetcher.data, toast]);

  const addRow = () => setPairs((prev) => [...prev, { key: "", value: "" }]);
  const removeRow = (index: number) =>
    setPairs((prev) => prev.filter((_, i) => i !== index));
  const updateRow = (index: number, field: "key" | "value", value: string) =>
    setPairs((prev) =>
      prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)),
    );

  const submit = (intent: "save" | "saveAndSync") => {
    const attributesJson = JSON.stringify(
      Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key, p.value])),
    );
    fetcher.submit(
      { intent, categoryId, attributesJson },
      { method: "POST" },
    );
  };

  const loadAttributes = () =>
    fetcher.submit({ intent: "loadAttributes", categoryId }, { method: "POST" });

  const isBusy = fetcher.state !== "idle";

  const searchResults =
    linkFetcher.data?.intent === "searchDaraz" ? linkFetcher.data.results : [];
  const isSearching =
    linkFetcher.state !== "idle" && linkFetcher.formData?.get("intent") === "searchDaraz";
  const linkingItemId =
    linkFetcher.state !== "idle" && linkFetcher.formData?.get("intent") === "link"
      ? String(linkFetcher.formData?.get("itemId"))
      : null;

  return (
    <Page backAction={{ url: "/app/daraz/products" }} title={`Map: ${data.title}`}>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Link an existing Daraz product
            </Text>
            {data.darazItemId && (
              <Text as="p" tone="subdued" variant="bodySm">
                Currently linked to Daraz item {data.darazItemId}.
              </Text>
            )}
            <Text as="p" tone="subdued" variant="bodySm">
              Already have this product listed on Daraz? Search by SKU or
              title and link it here instead of creating a duplicate.
            </Text>
            <InlineStack gap="200" blockAlign="end">
              <div style={{ minWidth: 280 }}>
                <TextField
                  label="SKU or title"
                  labelHidden
                  placeholder="SKU or title"
                  value={query}
                  onChange={setQuery}
                  autoComplete="off"
                />
              </div>
              <Button
                onClick={() =>
                  linkFetcher.submit({ intent: "searchDaraz", query }, { method: "POST" })
                }
                loading={isSearching}
                disabled={!query}
              >
                Search Daraz
              </Button>
            </InlineStack>
            {searchResults.length > 0 && (
              <BlockStack gap="200">
                {searchResults.map((product) => (
                  <InlineStack
                    key={product.item_id}
                    align="space-between"
                    blockAlign="center"
                  >
                    <BlockStack gap="0">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {product.attributes?.name ?? `Item ${product.item_id}`}
                      </Text>
                      <Text as="span" tone="subdued" variant="bodySm">
                        Item {product.item_id} · {product.skus.length} SKU(s)
                      </Text>
                    </BlockStack>
                    <Button
                      loading={linkingItemId === product.item_id}
                      onClick={() =>
                        linkFetcher.submit(
                          {
                            intent: "link",
                            itemId: product.item_id,
                            linkCategoryId: product.primary_category,
                            skuId: product.skus[0]?.SkuId ?? "",
                          },
                          { method: "POST" },
                        )
                      }
                    >
                      Link this product
                    </Button>
                  </InlineStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            Daraz category
          </Text>
          {categoryTree.length === 0 ? (
            <InlineStack gap="200" blockAlign="center">
              <Button onClick={loadCategoryTree} loading={isLoadingCategories}>
                Load Daraz categories
              </Button>
              <Text as="p" tone="subdued" variant="bodySm">
                Fetches Daraz's category list so you can pick one instead of
                typing an ID - can take a few seconds.
              </Text>
            </InlineStack>
          ) : (
            <BlockStack gap="200">
              {(
                [categoryTree, ...categoryPath.map((n) => n.children)] as DarazCategoryNode[][]
              )
                .filter((level) => level.length > 0)
                .map((levelOptions, level) => (
                  <div key={level} style={{ maxWidth: 320 }}>
                    <Select
                      label={level === 0 ? "Category" : "Subcategory"}
                      labelHidden={level > 0}
                      options={[
                        { label: "Select…", value: "" },
                        ...levelOptions.map((n) => ({ label: n.name, value: n.id })),
                      ]}
                      value={categoryPath[level]?.id ?? ""}
                      onChange={(value) => selectCategoryAtLevel(level, value)}
                    />
                  </div>
                ))}
              {categoryId ? (
                <Text as="p" tone="subdued" variant="bodySm">
                  Selected category ID: {categoryId}
                </Text>
              ) : (
                <Text as="p" tone="subdued" variant="bodySm">
                  Keep narrowing down until there are no more subcategories to pick.
                </Text>
              )}
            </BlockStack>
          )}
          <InlineStack gap="200" blockAlign="end">
            <div style={{ minWidth: 240 }}>
              <TextField
                label="Category ID (manual override)"
                placeholder="e.g. 12345"
                value={categoryId}
                onChange={(value) => {
                  setCategoryId(value);
                  setCategoryPath([]);
                }}
                autoComplete="off"
              />
            </div>
            <Button onClick={loadAttributes} disabled={!categoryId || isBusy}>
              Load suggested attributes
            </Button>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            Suggested attribute names are best-effort - add or edit any
            attribute Daraz requires for this category.
          </Text>

          <Divider />

          <Text as="h2" variant="headingMd">
            Attributes
          </Text>
          <BlockStack gap="200">
            {pairs.map((pair, index) => (
              <InlineStack key={index} gap="200" blockAlign="center">
                <div style={{ minWidth: 200 }}>
                  <TextField
                    label="Attribute name"
                    labelHidden
                    placeholder="Attribute name"
                    value={pair.key}
                    onChange={(v) => updateRow(index, "key", v)}
                    autoComplete="off"
                  />
                </div>
                <div style={{ minWidth: 240 }}>
                  <TextField
                    label="Value"
                    labelHidden
                    placeholder="Value"
                    value={pair.value}
                    onChange={(v) => updateRow(index, "value", v)}
                    autoComplete="off"
                  />
                </div>
                <Button variant="plain" tone="critical" onClick={() => removeRow(index)}>
                  Remove
                </Button>
              </InlineStack>
            ))}
            <InlineStack>
              <Button onClick={addRow}>Add attribute</Button>
            </InlineStack>
          </BlockStack>

          <Divider />

          <InlineStack gap="200">
            <Button loading={isBusy} onClick={() => submit("save")}>
              Save mapping
            </Button>
            <Button variant="primary" loading={isBusy} onClick={() => submit("saveAndSync")}>
              Save & sync now
            </Button>
          </InlineStack>
        </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

// Temporary: surfaces loader/action failures directly in the page instead of
// them getting swallowed by the app-level ErrorBoundary (which can render as
// a blank/broken panel inside the embedded admin iframe).
export function ErrorBoundary() {
  const error = useRouteError();
  console.error("[Daraz mapping] route ErrorBoundary caught:", error);

  if (isRouteErrorResponse(error)) {
    return (
      <Page backAction={{ url: "/app/daraz/products" }} title="Failed to load mapping page">
        <Card>
          <Text as="p" tone="critical">
            {error.status} {error.statusText}: {String(error.data)}
          </Text>
        </Card>
      </Page>
    );
  }

  return (
    <Page backAction={{ url: "/app/daraz/products" }} title="Failed to load mapping page">
      <Card>
        <Text as="p" tone="critical">
          {error instanceof Error ? error.message : String(error)}
        </Text>
      </Card>
    </Page>
  );
}
