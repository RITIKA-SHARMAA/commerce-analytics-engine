import mongoose from "mongoose";
import Redis from "ioredis";
import { Worker } from "bullmq";
import { config } from "../../api/src/config";
import { INGESTION_QUEUE, SCHEDULED_QUEUE, createQueues, closeQueues } from "../../api/src/queue";
import { ReadThroughCache } from "../../api/src/cache";
import { TokenBucket } from "../../api/src/limiter";
import { AdsConnector } from "../../api/src/connector";
import { logger } from "../../api/src/logger";
import { processOrder, syncAdSpend, checkRoasAndAlert, routeExhaustedJobsToDeadLetter, type OrderJobData } from "./processors";

async function main() {
  await mongoose.connect(config.mongoUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const queues = createQueues(redis);
  const cache = new ReadThroughCache(redis, config.cacheTtl);
  // Outbound bucket: at most 10 requests in a burst, refilling 2 per second, shared by every worker instance.
  const connector = new AdsConnector(new TokenBucket(redis, 10, 2));

  const workerConnections = [redis.duplicate(), redis.duplicate()];
  const ingestion = new Worker<OrderJobData>(INGESTION_QUEUE, job => processOrder(job.data, cache), { connection: workerConnections[0], concurrency: 8 });

  const scheduled = new Worker(SCHEDULED_QUEUE, async job => {
    const storeId = String(job.data?.storeId ?? config.defaultStoreId);
    if (job.name === "ads-sync") return syncAdSpend(storeId, config.adsCampaignIds, connector, cache);
    if (job.name === "roas-alert") return checkRoasAndAlert(storeId, { slackWebhookUrl: config.slackWebhookUrl, threshold: config.roasThreshold });
    throw new Error(`Unknown scheduled job: ${job.name}`);
  }, { connection: workerConnections[1], concurrency: 1 });

  for (const worker of [ingestion, scheduled]) {
    routeExhaustedJobsToDeadLetter(worker, queues.deadLetter);
    worker.on("completed", (job, result) => logger.info({ queue: job.queueName, jobId: job.id, result }, "job completed"));
  }

  // Repeatable jobs: upsertJobScheduler is idempotent, so restarting the worker does not duplicate schedules.
  await queues.scheduled.upsertJobScheduler("ads-sync", { pattern: config.adsSyncCron }, { name: "ads-sync", data: { storeId: config.defaultStoreId } });
  await queues.scheduled.upsertJobScheduler("roas-alert", { pattern: config.roasAlertCron }, { name: "roas-alert", data: { storeId: config.defaultStoreId } });
  logger.info({ adsSyncCron: config.adsSyncCron, roasAlertCron: config.roasAlertCron }, "worker started");

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "draining workers");
    await Promise.all([ingestion.close(), scheduled.close()]);
    await closeQueues(queues);
    await Promise.all(workerConnections.map(c => c.quit()));
    await redis.quit();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(error => { logger.error({ err: error }, "worker startup failed"); process.exit(1); });
