import { AdsConnector } from "../../apps/api/src/connector";

const row = (campaignId: string) => ({ campaignId, channel: "meta", spend: 120, currency: "USD", occurredAt: "2026-10-20T00:00:00Z" });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number, headers: Record<string, string> = {}) => new Response("{}", { status: code, headers });
const allowAll = { take: async () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 }) };

function setup(responses: Array<(body: { campaignIds: string[] }) => Response>, limiter = allowAll) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body.campaignIds);
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next(body);
  }) as unknown as typeof fetch;
  const connector = new AdsConnector(limiter, fetcher, "http://ads.test", async ms => { sleeps.push(ms); });
  return { connector, calls, sleeps };
}

describe("AdsConnector", () => {
  it("splits campaign ids into batches of the requested size", async () => {
    const echo = (b: { campaignIds: string[] }) => ok(b.campaignIds.map(row));
    const { connector, calls } = setup([echo, echo, echo]);
    const result = await connector.fetchSpend(["a", "b", "c", "d", "e"], 2);
    expect(calls).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(result.map(r => r.campaignId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(result[0].occurredAt).toBeInstanceOf(Date);
  });

  it("waits for Retry-After on 429 and then succeeds", async () => {
    const { connector, calls, sleeps } = setup([() => status(429, { "Retry-After": "2" }), b => ok(b.campaignIds.map(row))]);
    const result = await connector.fetchSpend(["meta-1"]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(result).toHaveLength(1);
  });

  it("retries 5xx responses with backoff", async () => {
    const { connector, sleeps } = setup([() => status(503), () => status(502), b => ok(b.campaignIds.map(row))]);
    await expect(connector.fetchSpend(["x"])).resolves.toHaveLength(1);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThanOrEqual(sleeps[0] / 2);
  });

  it("does not retry a non-retryable 4xx", async () => {
    const { connector, calls } = setup([() => status(400)]);
    await expect(connector.fetchSpend(["x"])).rejects.toThrow("status 400");
    expect(calls).toHaveLength(1);
  });

  it("gives up after the maximum number of retries", async () => {
    const { connector, calls } = setup(Array.from({ length: 6 }, () => () => status(429, { "Retry-After": "0" })));
    await expect(connector.fetchSpend(["x"])).rejects.toThrow("after 5 retries");
    expect(calls).toHaveLength(6);
  });

  it("waits on the outbound rate limiter before sending", async () => {
    let denials = 2;
    const limiter = { take: async () => (denials-- > 0 ? { allowed: false, remaining: 0, retryAfterSeconds: 1 } : { allowed: true, remaining: 1, retryAfterSeconds: 0 }) };
    const { connector, calls, sleeps } = setup([b => ok(b.campaignIds.map(row))], limiter);
    await connector.fetchSpend(["x"]);
    expect(sleeps).toEqual([1000, 1000]);
    expect(calls).toHaveLength(1);
  });

  it("rejects a malformed response body", async () => {
    const { connector } = setup([() => ok([{ campaignId: "x", spend: -5 }])]);
    await expect(connector.fetchSpend(["x"])).rejects.toThrow();
  });
});
