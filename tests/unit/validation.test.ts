import crypto from "node:crypto";
import { verifyShopifyHmac } from "../../apps/api/src/app";
import { adSpendSchema, shopifyOrderSchema } from "../../apps/api/src/validation";

describe("verifyShopifyHmac", () => {
  const secret = "s3cret";
  const body = Buffer.from(JSON.stringify({ id: 1, total_price: "10.00" }));
  const sign = (b: Buffer, s = secret) => crypto.createHmac("sha256", s).update(b).digest("base64");

  it("accepts the signature of the exact raw body", () => {
    expect(verifyShopifyHmac(body, sign(body), secret)).toBe(true);
  });
  it("rejects a signature made with another secret", () => {
    expect(verifyShopifyHmac(body, sign(body, "other"), secret)).toBe(false);
  });
  it("rejects a tampered body", () => {
    expect(verifyShopifyHmac(Buffer.from(body.toString().replace("10.00", "99.00")), sign(body), secret)).toBe(false);
  });
  it("rejects a missing or wrong-length signature without throwing", () => {
    expect(verifyShopifyHmac(body, "", secret)).toBe(false);
    expect(verifyShopifyHmac(body, "abc", secret)).toBe(false);
  });
});

describe("request schemas", () => {
  it("coerces Shopify string prices and dates", () => {
    const parsed = shopifyOrderSchema.parse({ id: 5, customer: { id: "c", touchpoints: [{ channel: "meta", occurredAt: "2026-10-01T00:00:00Z" }] }, total_price: "19.50", created_at: "2026-10-02T00:00:00Z" });
    expect(parsed.total_price).toBe(19.5);
    expect(parsed.created_at).toBeInstanceOf(Date);
    expect(parsed.customer.touchpoints?.[0].occurredAt).toBeInstanceOf(Date);
  });
  it("rejects an order without a customer or with a negative price", () => {
    expect(shopifyOrderSchema.safeParse({ id: 5, total_price: "1" }).success).toBe(false);
    expect(shopifyOrderSchema.safeParse({ id: 5, customer: { id: 1 }, total_price: "-1" }).success).toBe(false);
  });
  it("normalises ad-spend channel case and rejects negative spend", () => {
    expect(adSpendSchema.parse({ storeId: "s", channel: "Meta", spend: 10, occurredAt: "2026-10-01" }).channel).toBe("meta");
    expect(adSpendSchema.safeParse({ storeId: "s", channel: "meta", spend: -1, occurredAt: "2026-10-01" }).success).toBe(false);
  });
});
