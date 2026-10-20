import type Redis from "ioredis";

export class ReadThroughCache {
  constructor(private redis: Redis, private ttlSeconds = 60) {}

  async get<T>(key: string, load: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
    const cached = await this.redis.get(key);
    if (cached !== null) return { value: JSON.parse(cached) as T, hit: true };
    const value = await load();
    await this.redis.set(key, JSON.stringify(value), "EX", this.ttlSeconds);
    return { value, hit: false };
  }

  /** Deletes every cached metric for a store. Uses SCAN so Redis is never blocked the way KEYS would block it. */
  async invalidateStore(storeId: string): Promise<number> {
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `metrics:${storeId}:*`, "COUNT", 200);
      cursor = next;
      if (keys.length) deleted += await this.redis.unlink(...keys);
    } while (cursor !== "0");
    return deleted;
  }
}
