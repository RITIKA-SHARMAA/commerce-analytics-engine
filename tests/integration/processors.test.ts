import { Order, Touchpoint, AdSpend } from "../../apps/api/src/models";
import { processOrder, syncAdSpend, checkRoasAndAlert } from "../../apps/worker/src/processors";
import { connectTestMongo, clearCollections, disconnectTestMongo } from "../helpers/mongo";

const cacheSpy = () => ({ invalidateStore: jest.fn(async () => 0) });

describe("worker processors", () => {
  beforeAll(() => connectTestMongo("cae_processors"));
  afterEach(() => clearCollections());
  afterAll(() => disconnectTestMongo());

  describe("processOrder", () => {
    const payload = {
      id: 991, total_price: "120.50", currency: "INR", created_at: "2026-10-20T10:00:00Z", landing_site_ref: "Meta",
      customer: { id: 42, touchpoints: [
        { channel: "Google", campaignId: "search", occurredAt: "2026-10-19T08:00:00Z" },
        { channel: "meta", occurredAt: "2026-10-20T09:00:00Z" }
      ] }
    };

    it("normalises the order and its touchpoints, then invalidates the store cache", async () => {
      const cache = cacheSpy();
      await expect(processOrder({ storeId: "s", payload }, cache)).resolves.toEqual({ orderId: "991", touchpoints: 2 });
      const order = await Order.findOne({ storeId: "s", orderId: "991" }).lean();
      expect(order).toMatchObject({ customerId: "42", channel: "meta", total: 120.5, currency: "INR" });
      const touches = await Touchpoint.find({ storeId: "s" }).sort({ occurredAt: 1 }).lean();
      expect(touches.map(t => t.channel)).toEqual(["google", "meta"]);
      expect(cache.invalidateStore).toHaveBeenCalledWith("s");
    });

    it("is idempotent when BullMQ retries the same job", async () => {
      const cache = cacheSpy();
      await processOrder({ storeId: "s", payload }, cache);
      await processOrder({ storeId: "s", payload: { ...payload, total_price: "999" } }, cache);
      expect(await Order.countDocuments({ storeId: "s" })).toBe(1);
      expect((await Order.findOne({ storeId: "s" }).lean())?.total).toBe(120.5); // first write wins
      expect(await Touchpoint.countDocuments({ storeId: "s" })).toBe(2);
    });

    it("throws on a malformed payload so the job is retried and eventually dead-lettered", async () => {
      await expect(processOrder({ storeId: "s", payload: { id: 1 } }, cacheSpy())).rejects.toThrow();
      expect(await Order.countDocuments()).toBe(0);
    });
  });

  describe("syncAdSpend", () => {
    const connector = (spend: number) => ({ fetchSpend: jest.fn(async (ids: string[]) => ids.map(campaignId => ({
      campaignId, channel: campaignId.startsWith("google") ? "Google" : "meta", spend, currency: "USD", occurredAt: new Date("2026-10-20T15:30:00Z")
    }))) });

    it("upserts one row per campaign per day, so a re-sync overwrites instead of duplicating", async () => {
      const cache = cacheSpy();
      await syncAdSpend("s", ["meta-a", "google-b"], connector(100), cache);
      await syncAdSpend("s", ["meta-a", "google-b"], connector(140), cache);
      const rows = await AdSpend.find({ storeId: "s" }).sort({ campaignId: 1 }).lean();
      expect(rows).toHaveLength(2);
      expect(rows.map(r => [r.campaignId, r.channel, r.spend, r.occurredAt.toISOString()])).toEqual([
        ["google-b", "google", 140, "2026-10-20T00:00:00.000Z"],
        ["meta-a", "meta", 140, "2026-10-20T00:00:00.000Z"]
      ]);
      expect(cache.invalidateStore).toHaveBeenCalledTimes(2);
    });
  });

  describe("checkRoasAndAlert", () => {
    const now = new Date("2026-10-21T09:00:00Z");
    const yesterday = new Date("2026-10-20T12:00:00Z");
    const slack = (status = 200) => jest.fn(async (_url: string, _init: RequestInit) => new Response("ok", { status }));
    const seed = async (revenue: number, spend: number) => {
      await Order.create({ storeId: "s", orderId: "o1", customerId: "c", channel: "meta", total: revenue, occurredAt: yesterday });
      await AdSpend.create({ storeId: "s", channel: "meta", spend, occurredAt: yesterday });
    };

    it("posts a Slack alert when yesterday's ROAS is below the threshold", async () => {
      await seed(100, 100);
      const fetcher = slack();
      const result = await checkRoasAndAlert("s", { slackWebhookUrl: "https://hooks.slack.test/x", threshold: 1.5, fetcher: fetcher as unknown as typeof fetch, now });
      expect(result).toMatchObject({ sent: true, roas: 1 });
      const body = JSON.parse(String(fetcher.mock.calls[0][1].body));
      expect(body.text).toContain("1.00x is below the 1.5x threshold");
      expect(body.text).toContain("2026-10-20");
      expect(body.text).toContain("Weakest channel: meta");
    });

    it("stays quiet when ROAS is healthy or there was no spend", async () => {
      await seed(400, 100);
      const fetcher = slack();
      expect(await checkRoasAndAlert("s", { slackWebhookUrl: "https://hooks.slack.test/x", threshold: 1.5, fetcher: fetcher as unknown as typeof fetch, now })).toMatchObject({ sent: false, reason: "above threshold", roas: 4 });
      expect(await checkRoasAndAlert("empty", { slackWebhookUrl: "https://hooks.slack.test/x", threshold: 1.5, fetcher: fetcher as unknown as typeof fetch, now })).toMatchObject({ sent: false, reason: "no ad spend" });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("throws when Slack rejects the message so BullMQ retries the job", async () => {
      await seed(50, 100);
      await expect(checkRoasAndAlert("s", { slackWebhookUrl: "https://hooks.slack.test/x", threshold: 1.5, fetcher: slack(500) as unknown as typeof fetch, now })).rejects.toThrow("status 500");
    });

    it("skips sending when no Slack webhook is configured", async () => {
      await seed(50, 100);
      expect(await checkRoasAndAlert("s", { slackWebhookUrl: "", threshold: 1.5, now })).toMatchObject({ sent: false, reason: "slack not configured" });
    });
  });
});
