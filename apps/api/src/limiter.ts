import type Redis from "ioredis";
import type { RequestHandler } from "express";

/**
 * Token bucket in a single Lua script: refill, take and write-back happen atomically on the
 * Redis server, so concurrent API instances can never spend more tokens than the bucket holds.
 * Returns {allowed (0|1), tokens remaining, seconds until one token is available}.
 */
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local values = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local tokens = tonumber(values[1]) or capacity
local updated = tonumber(values[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - updated) * refill)
local allowed = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated', now)
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / math.max(refill, 0.001)) + 5)
local wait = 0
if allowed == 0 then wait = math.ceil((cost - tokens) / math.max(refill, 0.001)) end
return {allowed, tostring(tokens), wait}
`;

export type TakeResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

export class TokenBucket {
  constructor(
    private redis: Redis,
    private capacity = 60,
    private refillPerSecond = 1,
    private clock: () => number = () => Date.now() / 1000
  ) {}

  async take(key: string, cost = 1): Promise<TakeResult> {
    const [allowed, remaining, wait] = await this.redis.eval(
      TOKEN_BUCKET_LUA, 1, `bucket:${key}`, this.capacity, this.refillPerSecond, this.clock(), cost
    ) as [number, string, number];
    return { allowed: Number(allowed) === 1, remaining: Number(remaining), retryAfterSeconds: Number(wait) };
  }

  /** Express middleware keyed on client IP (honours X-Forwarded-For when `trust proxy` is set on the app). */
  middleware(): RequestHandler {
    return (req, res, next) => {
      this.take(`http:${req.ip ?? "unknown"}`)
        .then(result => {
          res.setHeader("X-RateLimit-Remaining", Math.floor(result.remaining));
          if (!result.allowed) {
            res.setHeader("Retry-After", result.retryAfterSeconds);
            res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
            return;
          }
          next();
        })
        .catch(next);
    };
  }
}
