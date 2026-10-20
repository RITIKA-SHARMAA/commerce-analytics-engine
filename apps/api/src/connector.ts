import { z } from "zod";
import { config } from "./config";
import type { TokenBucket } from "./limiter";
import { logger } from "./logger";

export const MAX_RETRIES = 5;

/** Honours a numeric Retry-After (seconds); otherwise capped exponential backoff with jitter. */
export const delayForRetry = (attempt: number, retryAfterHeader?: string | null, random = Math.random) => {
  const parsed = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, 60_000);
  const ceiling = Math.min(30_000, 500 * (2 ** attempt));
  return Math.floor(ceiling / 2 + random() * ceiling / 2);
};

const spendRowSchema = z.object({
  campaignId: z.string(),
  channel: z.string(),
  spend: z.number().nonnegative(),
  currency: z.string().default("USD"),
  occurredAt: z.coerce.date()
});
export type SpendRow = z.infer<typeof spendRowSchema>;

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class AdsConnector {
  constructor(
    private limiter: Pick<TokenBucket, "take">,
    private fetcher: typeof fetch = fetch,
    private baseUrl: string = config.mockAdsUrl,
    private sleep: Sleep = realSleep
  ) {}

  /** Fetches spend in batches; every request first takes a token from the shared outbound bucket. */
  async fetchSpend(campaignIds: string[], batchSize = 50): Promise<SpendRow[]> {
    const output: SpendRow[] = [];
    for (let offset = 0; offset < campaignIds.length; offset += batchSize) {
      const batch = campaignIds.slice(offset, offset + batchSize);
      let attempt = 0;
      for (;;) {
        const token = await this.limiter.take("outbound:ads");
        if (!token.allowed) {
          await this.sleep(Math.max(100, token.retryAfterSeconds * 1000));
          continue;
        }
        const response = await this.fetcher(`${this.baseUrl}/ads/spend`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ campaignIds: batch })
        });
        if (response.ok) {
          output.push(...z.array(spendRowSchema).parse(await response.json()));
          break;
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= MAX_RETRIES) throw new Error(`Ads API request failed with status ${response.status} after ${attempt} retries`);
        const wait = delayForRetry(attempt++, response.headers.get("retry-after"));
        logger.warn({ status: response.status, wait, attempt }, "ads API throttled or unavailable; retrying");
        await this.sleep(wait);
      }
    }
    return output;
  }
}
