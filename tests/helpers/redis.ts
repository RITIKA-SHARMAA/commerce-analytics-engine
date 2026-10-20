import Redis from "ioredis";
import crypto from "node:crypto";

/** Redis on logical db 15 so tests never touch development data. Requires a reachable REDIS_URL. */
export function testRedis() {
  return new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { db: 15, maxRetriesPerRequest: null });
}

/** Unique BullMQ prefix per suite, so parallel or repeated runs never see each other's jobs. */
export const uniquePrefix = (name: string) => `test-${name}-${crypto.randomUUID().slice(0, 8)}`;
