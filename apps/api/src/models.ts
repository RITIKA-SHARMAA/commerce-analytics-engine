import mongoose, { Schema, Model } from "mongoose";

export interface IStore { storeId: string; name: string; currency: string }
export interface IOrder {
  storeId: string; orderId: string; customerId: string; channel: string;
  total: number; currency: string; occurredAt: Date; source: string;
}
export interface ITouchpoint {
  storeId: string; customerId: string; channel: string; campaignId?: string;
  occurredAt: Date; source: string;
}
export interface IAdSpend {
  storeId: string; channel: string; campaignId?: string; spend: number;
  currency: string; occurredAt: Date;
}

const StoreSchema = new Schema<IStore>({
  storeId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  currency: { type: String, default: "USD" }
}, { timestamps: true });

const OrderSchema = new Schema<IOrder>({
  storeId: { type: String, required: true },
  orderId: { type: String, required: true },
  customerId: { type: String, required: true },
  channel: { type: String, default: "direct" },
  total: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "USD" },
  occurredAt: { type: Date, required: true },
  source: { type: String, default: "shopify" }
}, { timestamps: true });
// Per-store idempotency: the same Shopify order can never be stored twice.
OrderSchema.index({ storeId: 1, orderId: 1 }, { unique: true });
// Tenant + date range + channel filters used by the ROAS pipeline.
OrderSchema.index({ storeId: 1, occurredAt: 1, channel: 1 });
// Customer-scoped, time-bounded joins used by the attribution $lookup.
OrderSchema.index({ storeId: 1, customerId: 1, occurredAt: 1 });

const TouchpointSchema = new Schema<ITouchpoint>({
  storeId: { type: String, required: true },
  customerId: { type: String, required: true },
  channel: { type: String, required: true },
  campaignId: String,
  occurredAt: { type: Date, required: true },
  source: { type: String, default: "webhook" }
}, { timestamps: true });
TouchpointSchema.index({ storeId: 1, customerId: 1, occurredAt: 1 });
TouchpointSchema.index({ storeId: 1, channel: 1, occurredAt: 1 });

const AdSpendSchema = new Schema<IAdSpend>({
  storeId: { type: String, required: true },
  channel: { type: String, required: true },
  campaignId: String,
  spend: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "USD" },
  occurredAt: { type: Date, required: true }
}, { timestamps: true });
AdSpendSchema.index({ storeId: 1, occurredAt: 1, channel: 1 });
// One spend row per campaign per day, so connector re-syncs overwrite instead of duplicating.
AdSpendSchema.index({ storeId: 1, campaignId: 1, occurredAt: 1 }, { unique: true, partialFilterExpression: { campaignId: { $type: "string" } } });

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

export const Store = model<IStore>("Store", StoreSchema);
export const Order = model<IOrder>("Order", OrderSchema);
export const Touchpoint = model<ITouchpoint>("Touchpoint", TouchpointSchema);
export const AdSpend = model<IAdSpend>("AdSpend", AdSpendSchema);
