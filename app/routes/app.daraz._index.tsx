import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Link,
  Select,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createState } from "../daraz/state.server";
import { getAuthorizeUrl } from "../daraz/client.server";
import { DARAZ_SITES, isDarazCountry } from "../daraz/config.server";

const COUNTRY_OPTIONS = Object.entries(DARAZ_SITES).map(([value, site]) => ({
  label: site.label,
  value,
}));

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const account = await db.darazAccount.findUnique({
    where: { shop: session.shop },
  });

  return {
    connected: Boolean(account),
    country: account?.country ?? null,
    countryLabel:
      account && isDarazCountry(account.country)
        ? DARAZ_SITES[account.country].label
        : null,
    sellerId: account?.sellerId ?? null,
    connectedAt: account?.connectedAt ?? null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "disconnect") {
    await db.darazAccount.deleteMany({ where: { shop: session.shop } });
    return { disconnected: true };
  }

  const state = createState(session.shop);
  return { authorizeUrl: getAuthorizeUrl(state) };
};

export default function DarazIndex() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const isConnecting =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") !== "disconnect";
  const isDisconnecting =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "disconnect";

  useEffect(() => {
    if (fetcher.data && "authorizeUrl" in fetcher.data && fetcher.data.authorizeUrl) {
      // Break out of the embedded iframe - Daraz's login page refuses to render inside it.
      window.open(fetcher.data.authorizeUrl, "_top");
    }
    if (fetcher.data && "disconnected" in fetcher.data && fetcher.data.disconnected) {
      shopify.toast.show("Daraz account disconnected");
    }
  }, [fetcher.data, shopify]);

  const connect = () => fetcher.submit({ intent: "connect" }, { method: "POST" });
  const disconnect = () =>
    fetcher.submit({ intent: "disconnect" }, { method: "POST" });

  return (
    <Page>
      <TitleBar title="Daraz connection" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Daraz seller account
                  </Text>
                  <Badge tone={data.connected ? "success" : "attention"}>
                    {data.connected ? "Connected" : "Not connected"}
                  </Badge>
                </InlineStack>

                {data.connected ? (
                  <>
                    <Text as="p" variant="bodyMd">
                      Connected to Daraz {data.countryLabel}
                      {data.sellerId ? ` (seller ${data.sellerId})` : ""}.
                    </Text>
                    <InlineStack gap="300">
                      <Button
                        url="/app/daraz/products"
                        variant="primary"
                      >
                        Go to products
                      </Button>
                      <Button
                        tone="critical"
                        loading={isDisconnecting}
                        onClick={disconnect}
                      >
                        Disconnect
                      </Button>
                    </InlineStack>
                  </>
                ) : (
                  <>
                    <Text as="p" variant="bodyMd">
                      Connect your Daraz seller account to start syncing
                      products from this store.
                    </Text>
                    <InlineStack>
                      <Button
                        variant="primary"
                        loading={isConnecting}
                        onClick={connect}
                      >
                        Connect Daraz account
                      </Button>
                    </InlineStack>
                  </>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  About this connection
                </Text>
                <Text as="p" variant="bodyMd">
                  Authorization uses Daraz's OAuth flow. Tokens are encrypted
                  at rest and refreshed automatically before they expire.
                </Text>
                <Link
                  url="https://open.daraz.com/doc/doc.htm"
                  target="_blank"
                  removeUnderline
                >
                  Daraz Open Platform docs
                </Link>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
