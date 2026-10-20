import { z } from "zod";

const isoDate = z.union([z.string(), z.date()]).pipe(z.coerce.date());

export const shopifyOrderSchema = z.object({
  id: z.union([z.string().min(1), z.number()]),
  customer: z.object({
    id: z.union([z.string().min(1), z.number()]),
    touchpoints: z.array(z.object({
      channel: z.string().min(1),
      campaignId: z.string().optional(),
      occurredAt: isoDate
    })).optional()
  }),
  total_price: z.union([z.string(), z.number()]).pipe(z.coerce.number().nonnegative()),
  currency: z.string().length(3).optional(),
  created_at: isoDate.optional(),
  landing_site_ref: z.string().optional(),
  source_name: z.string().optional()
}).passthrough();
export type ShopifyOrder = z.infer<typeof shopifyOrderSchema>;

export const adSpendSchema = z.object({
  storeId: z.string().min(1),
  channel: z.string().min(1).transform(value => value.toLowerCase()),
  campaignId: z.string().optional(),
  spend: z.number().nonnegative(),
  currency: z.string().length(3).default("USD"),
  occurredAt: isoDate
});

export const metricsQuerySchema = z.object({
  storeId: z.string().min(1).default("demo-store"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  channel: z.string().min(1).optional()
});
