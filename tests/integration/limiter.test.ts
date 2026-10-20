import express from "express";
import request from "supertest";
import type Redis from "ioredis";
import { TokenBucket } from "../../apps/api/src/limiter";
import { testRedis, uniquePrefix } from "../helpers/redis";

describe("TokenBucket (real Redis Lua script)", () => {
  let redis: Redis;
  beforeAll(() => { redis = testRedis(); });
  afterAll(async () => { await redis.quit(); });

  it("allows exactly `capacity` requests, then refuses with a wait hint", async () => {
    const bucket = new TokenBucket(redis, 3, 1, () => 1000);
    const key = uniquePrefix("cap");
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await bucket.take(key));
    expect(results.map(r => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3].retryAfterSeconds).toBe(1);
  });

  it("refills based on elapsed time and never above capacity", async () => {
    let now = 5000;
    const bucket = new TokenBucket(redis, 2, 0.5, () => now);
    const key = uniquePrefix("refill");
    await bucket.take(key); await bucket.take(key);
    expect((await bucket.take(key)).allowed).toBe(false);
    now += 2; // 2s at 0.5 tokens/s = 1 token
    expect((await bucket.take(key)).allowed).toBe(true);
    expect((await bucket.take(key)).allowed).toBe(false);
    now += 1000; // long idle: refill is capped at capacity
    const after = await bucket.take(key);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(1);
  });

  it("stays atomic under concurrency: 50 parallel takes on a bucket of 10 admit exactly 10", async () => {
    const bucket = new TokenBucket(redis, 10, 0.0001);
    const key = uniquePrefix("race");
    const results = await Promise.all(Array.from({ length: 50 }, () => bucket.take(key)));
    expect(results.filter(r => r.allowed)).toHaveLength(10);
  });

  it("sets a TTL so idle buckets expire", async () => {
    const bucket = new TokenBucket(redis, 10, 1);
    const key = uniquePrefix("ttl");
    await bucket.take(key);
    const ttl = await redis.ttl(`bucket:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15);
  });

  it("middleware answers 429 with Retry-After once the client is out of tokens", async () => {
    const clientIp = uniquePrefix("ip");
    const app = express();
    const bucket = new TokenBucket(redis, 2, 0.01);
    app.use((req, _res, next) => { Object.defineProperty(req, "ip", { value: clientIp }); next(); });
    app.use(bucket.middleware());
    app.get("/", (_req, res) => { res.json({ ok: true }); });
    expect((await request(app).get("/")).status).toBe(200);
    expect((await request(app).get("/")).status).toBe(200);
    const limited = await request(app).get("/");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });
});
