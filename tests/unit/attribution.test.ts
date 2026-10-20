import { attributeRevenue } from "../../apps/api/src/attribution";
describe("attribution maths", () => {
  it("assigns full revenue to first and last touches and splits linear credit", () => {
    const result = attributeRevenue([
      { channel: "meta", occurredAt: "2026-01-01" },
      { channel: "google", occurredAt: "2026-01-02" },
      { channel: "meta", occurredAt: "2026-01-03" }
    ], 120);
    expect(result.firstTouch).toEqual({ meta: 120 });
    expect(result.lastTouch).toEqual({ meta: 120 });
    expect(result.linear).toEqual({ meta: 80, google: 40 });
  });
  it("handles an empty journey", () => {
    expect(attributeRevenue([], 20)).toEqual({ firstTouch: {}, lastTouch: {}, linear: {} });
  });
});
