import type Redis from "ioredis";
import { ReadThroughCache } from "../../apps/api/src/cache";
import { testRedis, uniquePrefix } from "../helpers/redis";

describe("ReadThroughCache (real Redis)", () => {
  let redis: Redis;
  let cache: ReadThroughCache;
  beforeAll(() => { redis = testRedis(); cache = new ReadThroughCache(redis, 30); });
  afterAll(async () => { await redis.quit(); });

  it("loads on a miss, serves the cached value on a hit, and sets the TTL", async () => {
    const store = uniquePrefix("store");
    const load = jest.fn(async () => ({ total: 42 }));
    const first = await cache.get(`metrics:${store}:roas`, load);
    const second = await cache.get(`metrics:${store}:roas`, load);
    expect(first).toEqual({ value: { total: 42 }, hit: false });
    expect(second).toEqual({ value: { total: 42 }, hit: true });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await redis.ttl(`metrics:${store}:roas`)).toBeGreaterThan(0);
  });

  it("caches falsy values instead of reloading them", async () => {
    const store = uniquePrefix("store");
    const load = jest.fn(async () => 0);
    await cache.get(`metrics:${store}:zero`, load);
    expect((await cache.get(`metrics:${store}:zero`, load)).hit).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("invalidates every key for one store across many SCAN pages, and nothing else", async () => {
    const target = uniquePrefix("target");
    const other = uniquePrefix("other");
    const pipeline = redis.pipeline();
    for (let i = 0; i < 650; i++) pipeline.set(`metrics:${target}:k${i}`, "1");
    pipeline.set(`metrics:${other}:keep`, "1");
    await pipeline.exec();
    expect(await cache.invalidateStore(target)).toBe(650);
    expect(await redis.exists(`metrics:${target}:k0`, `metrics:${target}:k649`)).toBe(0);
    expect(await redis.exists(`metrics:${other}:keep`)).toBe(1);
  });
});
