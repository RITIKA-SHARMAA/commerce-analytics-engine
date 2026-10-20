import "dotenv/config";

const list = (value: string | undefined, fallback: string[]) =>
  value ? value.split(",").map(s => s.trim()).filter(Boolean) : fallback;

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUrl: process.env.MONGO_URL ?? "mongodb://localhost:27017/commerce_analytics",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET ?? "development-secret",
  cacheTtl: Number(process.env.CACHE_TTL_SECONDS ?? 60),
  bucketCapacity: Number(process.env.TOKEN_BUCKET_CAPACITY ?? 60),
  bucketRefill: Number(process.env.TOKEN_BUCKET_REFILL_PER_SECOND ?? 1),
  trustProxy: process.env.TRUST_PROXY ?? "loopback",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
  roasThreshold: Number(process.env.ROAS_ALERT_THRESHOLD ?? 1.5),
  roasAlertCron: process.env.ROAS_ALERT_CRON ?? "0 9 * * *",
  mockAdsUrl: process.env.MOCK_ADS_URL ?? "http://localhost:4100",
  adsSyncCron: process.env.ADS_SYNC_CRON ?? "*/30 * * * *",
  adsCampaignIds: list(process.env.ADS_CAMPAIGN_IDS, ["meta-prospecting", "meta-retargeting", "google-search", "google-shopping"]),
  defaultStoreId: process.env.DEFAULT_STORE_ID ?? "demo-store"
};
