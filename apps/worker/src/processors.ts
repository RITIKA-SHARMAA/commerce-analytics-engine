import type { Job, Queue, Worker } from "bullmq";
import { Order, Touchpoint, AdSpend } from "../../api/src/models";
import { shopifyOrderSchema } from "../../api/src/validation";
import { dailyRoas } from "../../api/src/aggregations";
import type { ReadThroughCache } from "../../api/src/cache";
import type { AdsConnector } from "../../api/src/connector";
import { logger } from "../../api/src/logger";

export type OrderJobData = { storeId: string; payload: unknown };

/**
 * Normalises a Shopify order and its touchpoints. Every write is an idempotent upsert, so a retried
 * job never duplicates data. The store's metric cache is cleared only after the writes land, so a
 * dashboard read can never re-cache numbers from before this order existed.
 */
export async function processOrder(data: OrderJobData, cache: Pick<ReadThroughCache, "invalidateStore">) {
  const payload = shopifyOrderSchema.parse(data.payload);
  const { storeId } = data;
  const orderId = String(payload.id);
  const customerId = String(payload.customer.id);
  const channel = String(payload.landing_site_ref ?? payload.source_name ?? "direct").toLowerCase();
  await Order.updateOne({ storeId, orderId }, { $setOnInsert: {
    storeId, orderId, customerId, channel, total: payload.total_price,
    currency: payload.currency ?? "USD", occurredAt: payload.created_at ?? new Date(), source: "shopify"
  } }, { upsert: true });
  const touches = payload.customer.touchpoints ?? [];
  if (touches.length) {
    await Touchpoint.bulkWrite(touches.map(t => ({
      updateOne: {
        filter: { storeId, customerId, channel: t.channel.toLowerCase(), occurredAt: t.occurredAt },
        update: { $setOnInsert: { storeId, customerId, channel: t.channel.toLowerCase(), campaignId: t.campaignId, occurredAt: t.occurredAt, source: "shopify" } },
        upsert: true
      }
    })), { ordered: false });
  }
  await cache.invalidateStore(storeId);
  return { orderId, touchpoints: touches.length };
}

const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** Pulls spend from the ads API and upserts one row per campaign per day (re-syncs overwrite, never duplicate). */
export async function syncAdSpend(storeId: string, campaignIds: string[], connector: Pick<AdsConnector, "fetchSpend">, cache: Pick<ReadThroughCache, "invalidateStore">) {
  const rows = await connector.fetchSpend(campaignIds);
  if (rows.length) {
    await AdSpend.bulkWrite(rows.map(row => {
      const occurredAt = startOfUtcDay(row.occurredAt);
      return {
        updateOne: {
          filter: { storeId, campaignId: row.campaignId, occurredAt },
          update: { $set: { storeId, campaignId: row.campaignId, channel: row.channel.toLowerCase(), spend: row.spend, currency: row.currency, occurredAt } },
          upsert: true
        }
      };
    }), { ordered: false });
    await cache.invalidateStore(storeId);
  }
  return { synced: rows.length };
}

export type RoasAlertDeps = { slackWebhookUrl: string; threshold: number; fetcher?: typeof fetch; now?: Date };
export type RoasAlertResult = { sent: boolean; reason: string; roas: number | null; revenue: number; spend: number };

/** Checks yesterday's blended ROAS and posts a Slack alert when it falls below the threshold. Throws on Slack failure so BullMQ retries. */
export async function checkRoasAndAlert(storeId: string, deps: RoasAlertDeps): Promise<RoasAlertResult> {
  const today = startOfUtcDay(deps.now ?? new Date());
  const from = new Date(today.getTime() - 86_400_000);
  const to = new Date(today.getTime() - 1);
  const rows = await dailyRoas(storeId, from, to);
  const revenue = rows.reduce((sum, r) => sum + r.revenue, 0);
  const spend = rows.reduce((sum, r) => sum + r.spend, 0);
  const roas = spend > 0 ? revenue / spend : null;
  if (roas === null) return { sent: false, reason: "no ad spend", roas, revenue, spend };
  if (roas >= deps.threshold) return { sent: false, reason: "above threshold", roas, revenue, spend };
  if (!deps.slackWebhookUrl) {
    logger.warn({ storeId, roas }, "ROAS below threshold but SLACK_WEBHOOK_URL is not set");
    return { sent: false, reason: "slack not configured", roas, revenue, spend };
  }
  const worst = rows.filter(r => r.spend > 0).sort((a, b) => (a.roas ?? 0) - (b.roas ?? 0))[0];
  const text = [
    `:warning: ROAS alert for *${storeId}* on ${from.toISOString().slice(0, 10)}`,
    `Blended ROAS ${roas.toFixed(2)}x is below the ${deps.threshold}x threshold (revenue ${revenue.toFixed(2)}, spend ${spend.toFixed(2)}).`,
    worst ? `Weakest channel: ${worst.channel} at ${(worst.roas ?? 0).toFixed(2)}x.` : ""
  ].filter(Boolean).join("\n");
  const response = await (deps.fetcher ?? fetch)(deps.slackWebhookUrl, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text })
  });
  if (!response.ok) throw new Error(`Slack webhook failed with status ${response.status}`);
  return { sent: true, reason: "below threshold", roas, revenue, spend };
}

/** Copies a job to the dead-letter queue once BullMQ has exhausted all of its attempts. */
export function routeExhaustedJobsToDeadLetter(worker: Worker, deadLetter: Queue) {
  worker.on("failed", (job: Job | undefined, error: Error) => {
    logger.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err: error.message }, "job failed");
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    deadLetter.add(`dead:${job.name}`, {
      queue: job.queueName, originalJobId: job.id, name: job.name, data: job.data,
      error: error.message, attemptsMade: job.attemptsMade, failedAt: new Date().toISOString()
    }, { jobId: `dead:${job.queueName}:${job.id}` }).catch(err => logger.error({ err }, "could not write to dead-letter queue"));
  });
}
