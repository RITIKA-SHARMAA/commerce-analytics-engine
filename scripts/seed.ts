import mongoose from "mongoose";
import { config } from "../apps/api/src/config";
import { Store, Order, Touchpoint, AdSpend } from "../apps/api/src/models";

async function seed() {
  await mongoose.connect(config.mongoUrl);
  const storeId = "demo-store";
  await Promise.all([
    Store.deleteMany({ storeId }), Order.deleteMany({ storeId }),
    Touchpoint.deleteMany({ storeId }), AdSpend.deleteMany({ storeId })
  ]);
  await Store.create({ storeId, name: "Demo Outfitters", currency: "USD" });
  const channels = ["meta", "google", "email", "direct"];
  const now = new Date();
  const orders: any[] = [], touches: any[] = [], spends: any[] = [];
  for (let day = 13; day >= 0; day--) {
    const date = new Date(now); date.setUTCDate(date.getUTCDate() - day); date.setUTCHours(12,0,0,0);
    for (let c = 0; c < channels.length; c++) {
      spends.push({ storeId, channel: channels[c], campaignId: `${channels[c]}-campaign`, spend: 70 + c * 28 + (13-day)*3, occurredAt: date });
      for (let n = 0; n < (c === 3 ? 3 : 2); n++) {
        const customerId = `customer-${day}-${c}-${n}`;
        orders.push({ storeId, orderId: `order-${day}-${c}-${n}`, customerId, channel: channels[c], total: 95 + c*24 + n*18, currency: "USD", occurredAt: new Date(date.getTime()+n*3600000), source: "seed" });
        touches.push({ storeId, customerId, channel: channels[(c+n)%channels.length], campaignId: `${channels[(c+n)%channels.length]}-campaign`, occurredAt: new Date(date.getTime()-3600000), source: "seed" });
        touches.push({ storeId, customerId, channel: channels[c], campaignId: `${channels[c]}-campaign`, occurredAt: new Date(date.getTime()-1800000), source: "seed" });
      }
    }
  }
  await Promise.all([Order.insertMany(orders), Touchpoint.insertMany(touches), AdSpend.insertMany(spends)]);
  console.log(`Seeded ${orders.length} orders, ${touches.length} touchpoints, ${spends.length} ad-spend records.`);
  await mongoose.disconnect();
}
seed().catch(async error => { console.error(error); await mongoose.disconnect(); process.exit(1); });
