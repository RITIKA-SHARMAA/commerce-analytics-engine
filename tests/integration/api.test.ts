import request from "supertest";
import crypto from "node:crypto";
import type Redis from "ioredis";
import { createApp } from "../../apps/api/src/app";
import { createQueues, closeQueues, type Queues } from "../../apps/api/src/queue";
import { TokenBucket } from "../../apps/api/src/limiter";
import { Order, AdSpend } from "../../apps/api/src/models";
import { connectTestMongo, clearCollections, disconnectTestMongo } from "../helpers/mongo";
import { testRedis, uniquePrefix } from "../helpers/redis";

const SECRET = "test-webhook-secret";
const sign = (raw: string) => crypto.createHmac("sha256", SECRET).update(raw).digest("base64");

describe("HTTP API (Express + MongoDB + Redis + BullMQ)", () => {
  let redis: Redis;
  let queues: Queues;
  let runtime: ReturnType<typeof createApp>;
  let storeId: string;

  beforeAll(async () => {
    await connectTestMongo("cae_api");
    redis = testRedis();
    queues = createQueues(redis, uniquePrefix("api"));
    runtime = createApp({ redis, queues, webhookSecret: SECRET, limiter: new TokenBucket(redis, 1000, 1000) });
  });
  beforeEach(() => { storeId = uniquePrefix("store"); });
  afterEach(() => clearCollections());
  afterAll(async () => {
    await Promise.all([queues.ingestion.obliterate({ force: true }), queues.scheduled.obliterate({ force: true }), queues.deadLetter.obliterate({ force: true })]);
    await closeQueues(queues);
    await redis.quit();
    await disconnectTestMongo();
  });

  describe("POST /webhooks/shopify/orders", () => {
    const order = (id: number) => ({ id, customer: { id: 7, touchpoints: [{ channel: "meta", occurredAt: "2026-10-19T09:00:00Z" }] }, total_price: "29.99", created_at: "2026-10-20T10:00:00Z" });
    const send = (raw: string, signature = sign(raw)) => request(runtime.app).post("/webhooks/shopify/orders")
      .set("Content-Type", "application/json").set("x-shopify-hmac-sha256", signature).set("x-store-id", storeId).send(raw);

    it("rejects a missing or wrong signature with 401", async () => {
      const raw = JSON.stringify(order(1));
      expect((await request(runtime.app).post("/webhooks/shopify/orders").send(order(1))).status).toBe(401);
      expect((await send(raw, sign(raw + " "))).status).toBe(401);
    });

    it("rejects a correctly signed but invalid payload with 400 and field details", async () => {
      const raw = JSON.stringify({ id: 1, total_price: "abc" });
      const res = await send(raw);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["customer", "total_price"]));
    });

    it("queues a valid order with a deterministic job id and enqueues a redelivery only once", async () => {
      const raw = JSON.stringify(order(12345));
      const first = await send(raw);
      const second = await send(raw);
      expect(first.status).toBe(202);
      expect(first.body).toEqual({ accepted: true, duplicate: false, jobId: `${storeId}:12345` });
      expect(second.status).toBe(202);
      const job = await queues.ingestion.getJob(`${storeId}:12345`);
      expect(job?.data.storeId).toBe(storeId);
      const waiting = await queues.ingestion.getJobs(["waiting"]);
      expect(waiting.filter(j => j.id === `${storeId}:12345`)).toHaveLength(1);
    });

    it("answers 200 duplicate once the order is already persisted", async () => {
      await Order.create({ storeId, orderId: "777", customerId: "7", total: 10, occurredAt: new Date() });
      const res = await send(JSON.stringify(order(777)));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accepted: true, duplicate: true });
    });
  });

  describe("metrics endpoints", () => {
    const q = () => ({ storeId, from: "2026-10-20T00:00:00Z", to: "2026-10-20T23:59:59Z" });

    it("serves ROAS from MongoDB on a miss and from Redis on a hit", async () => {
      await Order.create({ storeId, orderId: "o1", customerId: "c1", channel: "meta", total: 200, occurredAt: new Date("2026-10-20T12:00:00Z") });
      await AdSpend.create({ storeId, channel: "meta", spend: 50, occurredAt: new Date("2026-10-20T12:00:00Z") });
      const miss = await request(runtime.app).get("/api/metrics/roas").query(q());
      const hit = await request(runtime.app).get("/api/metrics/roas").query(q());
      expect(miss.status).toBe(200);
      expect(miss.headers["x-cache"]).toBe("MISS");
      expect(hit.headers["x-cache"]).toBe("HIT");
      expect(miss.body.data[0]).toMatchObject({ channel: "meta", revenue: 200, spend: 50, roas: 4 });
      expect(hit.body.data).toEqual(miss.body.data);
    });

    it("rejects an inverted or unparseable date range with 400", async () => {
      const inverted = await request(runtime.app).get("/api/metrics/roas").query({ storeId, from: "2026-10-21", to: "2026-10-01" });
      expect(inverted.status).toBe(400);
      expect(inverted.body.error.code).toBe("INVALID_RANGE");
      const garbage = await request(runtime.app).get("/api/metrics/attribution").query({ storeId, from: "not-a-date" });
      expect(garbage.status).toBe(400);
    });

    it("returns attribution as one row per channel", async () => {
      const res = await request(runtime.app).get("/api/metrics/attribution").query(q());
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ channels: [], journeys: [] });
    });

    it("returns journey buckets", async () => {
      const res = await request(runtime.app).get("/api/metrics/journeys").query(q());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe("POST /api/ad-spend", () => {
    it("validates input and returns 400 for negative spend", async () => {
      const res = await request(runtime.app).post("/api/ad-spend").send({ storeId, channel: "meta", spend: -3, occurredAt: "2026-10-20" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("creates spend and invalidates that store's cached metrics", async () => {
      const query = { storeId, from: "2026-10-20T00:00:00Z", to: "2026-10-20T23:59:59Z" };
      await request(runtime.app).get("/api/metrics/roas").query(query);
      expect((await request(runtime.app).get("/api/metrics/roas").query(query)).headers["x-cache"]).toBe("HIT");
      const created = await request(runtime.app).post("/api/ad-spend").send({ storeId, channel: "Meta", spend: 40, occurredAt: "2026-10-20T08:00:00Z" });
      expect(created.status).toBe(201);
      expect(created.body.data.channel).toBe("meta");
      const after = await request(runtime.app).get("/api/metrics/roas").query(query);
      expect(after.headers["x-cache"]).toBe("MISS");
      expect(after.body.data[0]).toMatchObject({ channel: "meta", spend: 40, revenue: 0 });
    });
  });

  it("rate-limits /api routes per client with 429", async () => {
    const limited = createApp({ redis, queues, webhookSecret: SECRET, limiter: new TokenBucket(redis, 2, 0.001) });
    const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const hit = () => request(limited.app).get("/api/channels").set("X-Forwarded-For", ip);
    // trust proxy defaults to loopback, so supertest's 127.0.0.1 hop may set req.ip from X-Forwarded-For.
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    const res = await hit();
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect((await request(limited.app).get("/health")).status).toBe(200);
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(runtime.app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
