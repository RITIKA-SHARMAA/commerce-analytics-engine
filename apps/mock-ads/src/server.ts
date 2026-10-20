import express from "express";

/**
 * Local stand-in for a Meta/Google Ads reporting API. Every third request is throttled with
 * 429 + Retry-After so the connector's backoff path is exercised during normal local runs.
 */
const app = express();
app.use(express.json());
let requests = 0;

app.post("/ads/spend", (req, res) => {
  requests++;
  if (requests % 3 === 1) {
    res.setHeader("Retry-After", "1");
    res.status(429).json({ error: "rate_limited" });
    return;
  }
  const ids: string[] = Array.isArray(req.body?.campaignIds) ? req.body.campaignIds : [];
  res.json(ids.map(campaignId => ({
    campaignId,
    channel: campaignId.toLowerCase().includes("google") ? "google" : "meta",
    spend: 100 + campaignId.length * 7,
    currency: "USD",
    occurredAt: new Date().toISOString()
  })));
});

app.get("/health", (_req, res) => { res.json({ status: "ok" }); });

const port = Number(process.env.MOCK_ADS_PORT ?? 4100);
app.listen(port, () => console.log(`Mock ads API listening on ${port}`));
