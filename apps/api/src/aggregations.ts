import type { PipelineStage } from "mongoose";
import { Order, AdSpend, Touchpoint } from "./models";

export type RoasRow = { date: Date; channel: string; revenue: number; spend: number; orders: number; roas: number | null };
export type ChannelAttribution = { channel: string; firstTouch: number; lastTouch: number; linear: number; touches: number; customers: number };
export type JourneyBucket = { touches: number; customers: number; revenue: number };
export type AttributionSummary = { channels: ChannelAttribution[]; journeys: JourneyBucket[] };

const dayKey = (date: Date, channel: string) => `${new Date(date).toISOString()}|${channel}`;

/**
 * Daily ROAS per channel. Revenue and spend are grouped independently on the same (day, channel)
 * key and joined in memory: a $lookup between the two would multiply revenue by the number of
 * spend rows per day. Spend-only days are kept so a channel with zero sales still shows its cost.
 */
export async function dailyRoas(storeId: string, from: Date, to: Date, channel?: string): Promise<RoasRow[]> {
  const match = { storeId, occurredAt: { $gte: from, $lte: to }, ...(channel ? { channel } : {}) };
  const byDayAndChannel = { day: { $dateTrunc: { date: "$occurredAt", unit: "day" } }, channel: "$channel" };
  const [revenue, spend] = await Promise.all([
    Order.aggregate<{ _id: { day: Date; channel: string }; revenue: number; orders: number }>([
      { $match: match },
      { $group: { _id: byDayAndChannel, revenue: { $sum: "$total" }, orders: { $sum: 1 } } }
    ]),
    AdSpend.aggregate<{ _id: { day: Date; channel: string }; spend: number }>([
      { $match: match },
      { $group: { _id: byDayAndChannel, spend: { $sum: "$spend" } } }
    ])
  ]);
  const rows = new Map<string, RoasRow>();
  for (const r of revenue) {
    rows.set(dayKey(r._id.day, r._id.channel), { date: r._id.day, channel: r._id.channel, revenue: r.revenue, spend: 0, orders: r.orders, roas: null });
  }
  for (const s of spend) {
    const key = dayKey(s._id.day, s._id.channel);
    const row = rows.get(key) ?? { date: s._id.day, channel: s._id.channel, revenue: 0, spend: 0, orders: 0, roas: null };
    row.spend = s.spend;
    rows.set(key, row);
  }
  return [...rows.values()]
    .map(row => ({ ...row, roas: row.spend > 0 ? Number((row.revenue / row.spend).toFixed(4)) : null }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime() || a.channel.localeCompare(b.channel));
}

/**
 * Builds each customer's ordered journey, joins their revenue in the window, then computes three
 * attribution models in one pass with $facet:
 *  - first touch: 100% of revenue to the first channel
 *  - last touch:  100% of revenue to the last channel
 *  - linear:      revenue / touch count credited to every touch
 * The facets are merged into one row per channel inside the pipeline.
 */
export function attributionPipeline(storeId: string, from: Date, to: Date): PipelineStage[] {
  return [
    { $match: { storeId, occurredAt: { $gte: from, $lte: to } } },
    { $sort: { customerId: 1, occurredAt: 1 } },
    { $group: { _id: "$customerId", touches: { $push: "$channel" } } },
    { $lookup: {
      from: Order.collection.collectionName,
      let: { customer: "$_id" },
      pipeline: [
        { $match: { $expr: { $and: [
          { $eq: ["$storeId", storeId] },
          { $eq: ["$customerId", "$$customer"] },
          { $gte: ["$occurredAt", from] },
          { $lte: ["$occurredAt", to] }
        ] } } },
        { $group: { _id: null, revenue: { $sum: "$total" } } }
      ],
      as: "sales"
    } },
    { $set: {
      revenue: { $ifNull: [{ $arrayElemAt: ["$sales.revenue", 0] }, 0] },
      touchCount: { $size: "$touches" },
      firstChannel: { $arrayElemAt: ["$touches", 0] },
      lastChannel: { $arrayElemAt: ["$touches", -1] }
    } },
    { $facet: {
      firstTouch: [{ $group: { _id: "$firstChannel", value: { $sum: "$revenue" } } }],
      lastTouch: [{ $group: { _id: "$lastChannel", value: { $sum: "$revenue" } } }],
      linear: [
        { $unwind: "$touches" },
        { $group: {
          _id: "$touches",
          value: { $sum: { $divide: ["$revenue", "$touchCount"] } },
          touches: { $sum: 1 },
          customers: { $addToSet: "$_id" }
        } }
      ],
      journeys: [
        { $group: { _id: "$touchCount", customers: { $sum: 1 }, revenue: { $sum: "$revenue" } } },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, touches: "$_id", customers: 1, revenue: 1 } }
      ]
    } },
    { $project: {
      journeys: 1,
      channels: { $map: {
        input: "$linear",
        as: "l",
        in: {
          channel: "$$l._id",
          linear: { $round: ["$$l.value", 2] },
          touches: "$$l.touches",
          customers: { $size: "$$l.customers" },
          firstTouch: { $ifNull: [{ $arrayElemAt: [{ $map: { input: { $filter: { input: "$firstTouch", cond: { $eq: ["$$this._id", "$$l._id"] } } }, in: "$$this.value" } }, 0] }, 0] },
          lastTouch: { $ifNull: [{ $arrayElemAt: [{ $map: { input: { $filter: { input: "$lastTouch", cond: { $eq: ["$$this._id", "$$l._id"] } } }, in: "$$this.value" } }, 0] }, 0] }
        }
      } }
    } }
  ];
}

export async function attributionSummary(storeId: string, from: Date, to: Date): Promise<AttributionSummary> {
  const [result] = await Touchpoint.aggregate<AttributionSummary>(attributionPipeline(storeId, from, to));
  const channels = (result?.channels ?? []).sort((a, b) => b.linear - a.linear || a.channel.localeCompare(b.channel));
  return { channels, journeys: result?.journeys ?? [] };
}

export async function customerJourneyCounts(storeId: string, from: Date, to: Date) {
  return Touchpoint.aggregate([
    { $match: { storeId, occurredAt: { $gte: from, $lte: to } } },
    { $sort: { customerId: 1, occurredAt: 1 } },
    { $group: { _id: "$customerId", channels: { $push: "$channel" }, count: { $sum: 1 }, firstSeen: { $first: "$occurredAt" }, lastSeen: { $last: "$occurredAt" } } },
    { $set: { uniqueChannels: { $size: { $setUnion: ["$channels", []] } }, journeyDurationMs: { $subtract: ["$lastSeen", "$firstSeen"] } } },
    { $group: { _id: "$count", customers: { $sum: 1 }, averageUniqueChannels: { $avg: "$uniqueChannels" }, averageJourneyDurationMs: { $avg: "$journeyDurationMs" } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, touches: "$_id", customers: 1, averageUniqueChannels: 1, averageJourneyDurationMs: 1 } }
  ]);
}
