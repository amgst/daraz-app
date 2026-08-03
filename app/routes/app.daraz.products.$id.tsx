import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  Text,
  Divider,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getValidAccessToken } from "../daraz/tokens.server";
import { getCategoryAttributes } from "../daraz/client.server";
import { syncProduct } from "../daraz/sync.server";

const PRODUCT_TITLE_QUERY = `#graphql
  query DarazMappingProductTitle($id: ID!) {
    product(id: $id) { title }
  }
`;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = params.id!;

  const response = await admin.graphql(PRODUCT_TITLE_QUERY, {
    variables: { id: `gid://shopify/Product/${productId}` },
  });
  const json = await response.json();
  const title = json.data?.product?.title ?? "Unknown product";

  const mapping = await db.productMapping.findUnique({
    where: {
      shop_shopifyProductId: { shop: session.shop, shopifyProductId: productId },
    },
  });

  return {
    productId,
    title,
    categoryId: mapping?.darazCategoryId ?? "",
    attributes: mapping?.attributesJson
      ? (JSON.parse(mapping.attributesJson) as Record<string, string>)
      : {},
  };
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

export default function ProductMappingPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [categoryId, setCategoryId] = useState(data.categoryId);
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
        shopify.toast.show("No attribute suggestions available - add manually");
      } else {
        setPairs((prev) => [...prev, ...newPairs]);
      }
    } else if (fetcher.data.intent === "save") {
      if (fetcher.data.ok) {
        shopify.toast.show("Mapping saved");
      } else {
        shopify.toast.show(fetcher.data.error ?? "Save failed", { isError: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

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

  return (
    <Page backAction={{ url: "/app/daraz/products" }}>
      <TitleBar title={`Map: ${data.title}`} />
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            Daraz category
          </Text>
          <InlineStack gap="200" blockAlign="end">
            <div style={{ minWidth: 240 }}>
              <TextField
                label="Category ID"
                labelHidden
                placeholder="e.g. 12345"
                value={categoryId}
                onChange={setCategoryId}
                autoComplete="off"
              />
            </div>
            <Button onClick={loadAttributes} disabled={!categoryId || isBusy}>
              Load suggested attributes
            </Button>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            Find the category ID in your Daraz Seller Center category picker.
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
    </Page>
  );
}
