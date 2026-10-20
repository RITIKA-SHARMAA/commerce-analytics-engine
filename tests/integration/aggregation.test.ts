import { Order, AdSpend, Touchpoint } from "../../apps/api/src/models";
import { dailyRoas, attributionSummary, customerJourneyCounts } from "../../apps/api/src/aggregations";
import { attributeRevenue } from "../../apps/api/src/attribution";
import { connectTestMongo, clearCollections, disconnectTestMongo } from "../helpers/mongo";

const D1 = new Date("2026-10-19T12:00:00Z");
const D2 = new Date("2026-10-20T12:00:00Z");
const FROM = new Date("2026-10-19T00:00:00Z");
const TO = new Date("2026-10-20T23:59:59Z");
const at = (base: Date, hours: number) => new Date(base.getTime() + hours * 3_600_000);

describe("MongoDB aggregation pipelines", () => {
  beforeAll(() => connectTestMongo("cae_aggregation"));
  afterEach(() => clearCollections());
  afterAll(() => disconnectTestMongo());

  describe("dailyRoas", () => {
    beforeEach(async () => {
      await Order.create([
        { storeId: "s", orderId: "o1", customerId: "c1", channel: "meta", total: 200, occurredAt: D1 },
        { storeId: "s", orderId: "o2", customerId: "c2", channel: "meta", total: 100, occurredAt: at(D1, 3) },
        { storeId: "s", orderId: "o3", customerId: "c3", channel: "google", total: 90, occurredAt: D2 },
        { storeId: "other", orderId: "o1", customerId: "x", channel: "meta", total: 9999, occurredAt: D1 }
      ]);
      await AdSpend.create([
        { storeId: "s", channel: "meta", spend: 50, occurredAt: D1 },
        { storeId: "s", channel: "meta", spend: 25, occurredAt: at(D1, 1) },
        { storeId: "s", channel: "google", spend: 30, occurredAt: D2 },
        { storeId: "s", channel: "email", spend: 10, occurredAt: D2 }
      ]);
    });

    it("groups revenue and spend by day and channel and computes ROAS per row", async () => {
      const rows = await dailyRoas("s", FROM, TO);
      const simplified = rows.map(r => ({ day: new Date(r.date).toISOString().slice(0, 10), channel: r.channel, revenue: r.revenue, spend: r.spend, orders: r.orders, roas: r.roas }));
      expect(simplified).toEqual([
        { day: "2026-10-19", channel: "meta", revenue: 300, spend: 75, orders: 2, roas: 4 },
        { day: "2026-10-20", channel: "email", revenue: 0, spend: 10, orders: 0, roas: 0 },
        { day: "2026-10-20", channel: "google", revenue: 90, spend: 30, orders: 1, roas: 3 }
      ]);
    });

    it("returns null ROAS for a day with revenue but no spend", async () => {
      await Order.create({ storeId: "s", orderId: "o9", customerId: "c9", channel: "direct", total: 40, occurredAt: D2 });
      const direct = (await dailyRoas("s", FROM, TO)).find(r => r.channel === "direct");
      expect(direct).toMatchObject({ revenue: 40, spend: 0, roas: null });
    });

    it("filters by channel and isolates tenants", async () => {
      const rows = await dailyRoas("s", FROM, TO, "google");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: "google", revenue: 90 });
      const all = await dailyRoas("s", FROM, TO);
      expect(all.reduce((sum, r) => sum + r.revenue, 0)).toBe(390);
    });
  });

  describe("attributionSummary", () => {
    const journeys: Record<string, { touches: Array<{ channel: string; h: number }>; revenue: number }> = {
      c1: { touches: [{ channel: "meta", h: 0 }, { channel: "google", h: 1 }, { channel: "email", h: 2 }], revenue: 300 },
      c2: { touches: [{ channel: "google", h: 0 }], revenue: 100 },
      c3: { touches: [{ channel: "meta", h: 2 }, { channel: "meta", h: 0 }], revenue: 0 } // stored out of order on purpose
    };

    beforeEach(async () => {
      for (const [customerId, j] of Object.entries(journeys)) {
        await Touchpoint.create(j.touches.map(t => ({ storeId: "s", customerId, channel: t.channel, occurredAt: at(D1, t.h) })));
        if (j.revenue) await Order.create({ storeId: "s", orderId: `order-${customerId}`, customerId, channel: "meta", total: j.revenue, occurredAt: at(D1, 5) });
      }
      await Order.create({ storeId: "s", orderId: "outside", customerId: "c2", channel: "google", total: 5000, occurredAt: new Date("2026-09-01T00:00:00Z") });
    });

    it("matches the reference first-touch, last-touch and linear attribution maths", async () => {
      const expected = new Map<string, { firstTouch: number; lastTouch: number; linear: number }>();
      for (const j of Object.values(journeys)) {
        const r = attributeRevenue(j.touches.map(t => ({ channel: t.channel, occurredAt: at(D1, t.h) })), j.revenue);
        for (const [model, credits] of Object.entries(r) as Array<[ "firstTouch" | "lastTouch" | "linear", Record<string, number>]>) {
          for (const [channel, value] of Object.entries(credits)) {
            const entry = expected.get(channel) ?? { firstTouch: 0, lastTouch: 0, linear: 0 };
            entry[model] += value;
            expected.set(channel, entry);
          }
        }
      }
      const { channels } = await attributionSummary("s", FROM, TO);
      for (const c of channels) {
        const e = expected.get(c.channel)!;
        expect(c.firstTouch).toBeCloseTo(e.firstTouch, 2);
        expect(c.lastTouch).toBeCloseTo(e.lastTouch, 2);
        expect(c.linear).toBeCloseTo(e.linear, 2);
      }
      expect(channels.map(c => c.channel).sort()).toEqual([...expected.keys()].sort());
    });

    it("reports exact per-channel credit, touch counts and distinct customers", async () => {
      const { channels } = await attributionSummary("s", FROM, TO);
      const byChannel = Object.fromEntries(channels.map(c => [c.channel, c]));
      expect(byChannel.meta).toMatchObject({ firstTouch: 300, lastTouch: 0, linear: 100, touches: 3, customers: 2 });
      expect(byChannel.google).toMatchObject({ firstTouch: 100, lastTouch: 100, linear: 200, touches: 2, customers: 2 });
      expect(byChannel.email).toMatchObject({ firstTouch: 0, lastTouch: 300, linear: 100, touches: 1, customers: 1 });
      // Linear credit sums to total attributed revenue (orders outside the window are excluded).
      expect(channels.reduce((s, c) => s + c.linear, 0)).toBeCloseTo(400, 2);
    });

    it("buckets customers by journey length", async () => {
      const { journeys: buckets } = await attributionSummary("s", FROM, TO);
      expect(buckets).toEqual([
        { touches: 1, customers: 1, revenue: 100 },
        { touches: 2, customers: 1, revenue: 0 },
        { touches: 3, customers: 1, revenue: 300 }
      ]);
    });

    it("returns empty results for a store with no touchpoints", async () => {
      expect(await attributionSummary("nobody", FROM, TO)).toEqual({ channels: [], journeys: [] });
    });
  });

  it("customerJourneyCounts reports unique channels and journey duration per bucket", async () => {
    await Touchpoint.create([
      { storeId: "s", customerId: "a", channel: "meta", occurredAt: at(D1, 0) },
      { storeId: "s", customerId: "a", channel: "meta", occurredAt: at(D1, 2) },
      { storeId: "s", customerId: "b", channel: "google", occurredAt: at(D1, 0) }
    ]);
    const rows = await customerJourneyCounts("s", FROM, TO);
    expect(rows).toEqual([
      { touches: 1, customers: 1, averageUniqueChannels: 1, averageJourneyDurationMs: 0 },
      { touches: 2, customers: 1, averageUniqueChannels: 1, averageJourneyDurationMs: 7_200_000 }
    ]);
  });
});
