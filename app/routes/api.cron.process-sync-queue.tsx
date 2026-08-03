import type { LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { processSyncJob } from "../daraz/sync.server";

const BATCH_SIZE = 20;

// Vercel Cron target (see vercel.json). Vercel automatically sends
// `Authorization: Bearer ${CRON_SECRET}` on cron-triggered requests when
// CRON_SECRET is set as a project env var - this is the only auth here,
// since there's no Shopify session in a scheduled invocation.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const jobs = await db.syncJob.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  for (const job of jobs) {
    await processSyncJob(job);
  }

  return { processed: jobs.length };
};
