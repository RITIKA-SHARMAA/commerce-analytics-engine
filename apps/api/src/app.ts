import express, { type Request } from "express";
import cors from "cors";
import crypto from "node:crypto";
import Redis from "ioredis";
import { config } from "./config";
import { Store, Order, Touchpoint, AdSpend } from "./models";
import { createQueues, type Queues } from "./queue";
import { TokenBucket } from "./limiter";
import { ReadThroughCache } from "./cache";
import { dailyRoas, attributionSummary, customerJourneyCounts } from "./aggregations";
import { AppError, asyncRoute, errorHandler } from "./errors";
import { logger } from "./logger";
import { adSpendSchema, metricsQuerySchema, shopifyOrderSchema } from "./validation";

type RawBodyRequest = Request & { rawBody?: Buffer };

export type AppDeps = {
  redis?: Redis;
  queues?: Queues;
  limiter?: TokenBucket;
  cacheTtlSeconds?: number;
  webhookSecret?: string;
};

const DAY_MS = 86_400_000;

/** Constant-time HMAC check of the exact raw body, as Shopify signs it. */
export function verifyShopifyHmac(rawBody: Buffer, signature: string, secret: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(signature);
  const b = Buffer.from(digest);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseRange(query: unknown, defaultDays: number) {
  const parsed = metricsQuerySchema.parse(query);
  const to = parsed.to ?? new Date();
  const from = parsed.from ?? new Date(to.getTime() - defaultDays * DAY_MS);
  if (from > to) throw new AppError(400, "`from` must be before `to`", "INVALID_RANGE");
  if (to.getTime() - from.getTime() > 366 * DAY_MS) throw new AppError(400, "Range cannot exceed 366 days", "INVALID_RANGE");
  return { ...parsed, from, to };
}

export function createApp(deps: AppDeps = {}) {
  const redis = deps.redis ?? new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const queues = deps.queues ?? createQueues(redis);
  const limiter = deps.limiter ?? new TokenBucket(redis, config.bucketCapacity, config.bucketRefill);
  const cache = new ReadThroughCache(redis, deps.cacheTtlSeconds ?? config.cacheTtl);
  const secret = deps.webhookSecret ?? config.webhookSecret;

  const app = express();
  app.set("trust proxy", config.trustProxy);
  app.use(cors());
  app.use(express.json({ limit: "1mb", verify: (req, _res, buffer) => { (req as RawBodyRequest).rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => { logger.debug({ method: req.method, path: req.path }, "request"); next(); });

  app.get("/health", (_req, res) => { res.json({ status: "ok" }); });

  /**
   * Shopify order webhook. Duplicates are stopped at three layers: a persisted-order check here,
   * a deterministic BullMQ jobId (a second add with the same id is a no-op), and $setOnInsert
   * upserts behind a unique (storeId, orderId) index in the worker.
   */
  app.post("/webhooks/shopify/orders", asyncRoute(async (req, res) => {
    const signature = req.header("x-shopify-hmac-sha256") ?? "";
    const rawBody = (req as RawBodyRequest).rawBody ?? Buffer.alloc(0);
    if (!verifyShopifyHmac(rawBody, signature, secret)) throw new AppError(401, "Invalid webhook signature", "INVALID_SIGNATURE");
    const payload = shopifyOrderSchema.parse(req.body);
    const storeId = String(req.header("x-store-id") ?? config.defaultStoreId);
    const orderId = String(payload.id);
    if (await Order.exists({ storeId, orderId })) {
      res.status(200).json({ accepted: true, duplicate: true });
      return;
    }
    const jobId = `${storeId}:${orderId}`;
    await queues.ingestion.add("shopify-order", { storeId, payload: req.body }, { jobId });
    res.status(202).json({ accepted: true, duplicate: false, jobId });
  }));

  app.use("/api", limiter.middleware());

  app.get("/api/metrics/roas", asyncRoute(async (req, res) => {
    const { storeId, from, to, channel } = parseRange(req.query, 7);
    const key = `metrics:${storeId}:roas:${from.toISOString()}:${to.toISOString()}:${channel ?? "all"}`;
    const { value, hit } = await cache.get(key, () => dailyRoas(storeId, from, to, channel));
    res.setHeader("X-Cache", hit ? "HIT" : "MISS").json({ data: value });
  }));

  app.get("/api/metrics/attribution", asyncRoute(async (req, res) => {
    const { storeId, from, to } = parseRange(req.query, 30);
    const key = `metrics:${storeId}:attribution:${from.toISOString()}:${to.toISOString()}`;
    const { value, hit } = await cache.get(key, () => attributionSummary(storeId, from, to));
    res.setHeader("X-Cache", hit ? "HIT" : "MISS").json({ data: value });
  }));

  app.get("/api/metrics/journeys", asyncRoute(async (req, res) => {
    const { storeId, from, to } = parseRange(req.query, 30);
    const key = `metrics:${storeId}:journeys:${from.toISOString()}:${to.toISOString()}`;
    const { value, hit } = await cache.get(key, () => customerJourneyCounts(storeId, from, to));
    res.setHeader("X-Cache", hit ? "HIT" : "MISS").json({ data: value });
  }));

  app.get("/api/channels", asyncRoute(async (req, res) => {
    const storeId = String(req.query.storeId ?? config.defaultStoreId);
    const channels = await Touchpoint.distinct("channel", { storeId });
    res.json({ data: channels.sort() });
  }));

  app.get("/api/stores", asyncRoute(async (_req, res) => {
    res.json({ data: await Store.find().lean() });
  }));

  app.post("/api/ad-spend", asyncRoute(async (req, res) => {
    const input = adSpendSchema.parse(req.body);
    const record = await AdSpend.create(input);
    await cache.invalidateStore(record.storeId);
    res.status(201).json({ data: record });
  }));

  app.use((_req, res) => { res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } }); });
  app.use(errorHandler);
  return { app, redis, queues, cache, limiter };
}
