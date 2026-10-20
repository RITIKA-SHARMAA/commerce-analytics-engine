import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type RoasRow = { date: string; channel: string; revenue: number; spend: number; orders: number; roas: number | null };
type ChannelAttribution = { channel: string; firstTouch: number; lastTouch: number; linear: number; touches: number; customers: number };
type Attribution = { channels: ChannelAttribution[]; journeys: Array<{ touches: number; customers: number; revenue: number }> };

const api = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const STORE_ID = "demo-store";
const COLORS = ["#6d5ce8", "#13a10e", "#e8590c", "#1c7ed6", "#c2255c", "#868e96"];
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

async function getJson<T>(path: string, params: URLSearchParams): Promise<T> {
  const res = await fetch(`${api}${path}?${params}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return body.data as T;
}

export default function Dashboard() {
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 13 * 86_400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [channel, setChannel] = useState("all");
  const [rows, setRows] = useState<RoasRow[]>([]);
  const [attribution, setAttribution] = useState<Attribution>({ channels: [], journeys: [] });
  const [channels, setChannels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    getJson<string[]>("/api/channels", new URLSearchParams({ storeId: STORE_ID })).then(setChannels).catch(() => setChannels([]));
  }, [reloadKey]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ storeId: STORE_ID, from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T23:59:59Z`).toISOString() });
    const roasParams = new URLSearchParams(params);
    if (channel !== "all") roasParams.set("channel", channel);
    Promise.all([getJson<RoasRow[]>("/api/metrics/roas", roasParams), getJson<Attribution>("/api/metrics/attribution", params)])
      .then(([roas, attr]) => { if (active) { setRows(roas); setAttribution(attr); } })
      .catch((e: Error) => { if (active) setError(e.message || "Something went wrong"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [from, to, channel, reloadKey]);

  // One chart row per day with a ROAS column per channel.
  const { chartRows, chartChannels } = useMemo(() => {
    const byDay = new Map<string, Record<string, number | string | null>>();
    const seen = new Set<string>();
    for (const r of rows) {
      const day = r.date.slice(0, 10);
      const entry = byDay.get(day) ?? { day };
      entry[r.channel] = r.roas;
      byDay.set(day, entry);
      if (r.spend > 0) seen.add(r.channel);
    }
    return { chartRows: [...byDay.values()], chartChannels: [...seen].sort() };
  }, [rows]);

  const totals = useMemo(() => {
    const revenue = rows.reduce((s, r) => s + r.revenue, 0);
    const spend = rows.reduce((s, r) => s + r.spend, 0);
    return { revenue, spend, orders: rows.reduce((s, r) => s + r.orders, 0), roas: spend ? revenue / spend : null };
  }, [rows]);

  const maxLinear = Math.max(1, ...attribution.channels.map(c => c.linear));

  return <main>
    <header>
      <div>
        <p className="eyebrow">COMMERCE INTELLIGENCE</p>
        <h1>Marketing performance</h1>
        <p className="muted">Return on ad spend and revenue attribution for {STORE_ID}</p>
      </div>
      <button onClick={() => setReloadKey(k => k + 1)} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
    </header>

    <section className="filters">
      <label>From <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
      <label>To <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
      <label>Channel <select value={channel} onChange={e => setChannel(e.target.value)}>
        <option value="all">All channels</option>
        {channels.map(c => <option key={c} value={c}>{c}</option>)}
      </select></label>
    </section>

    {loading && rows.length === 0 ? <section className="panel state">Loading analytics…</section>
      : error ? <section className="panel state error">{error} <button onClick={() => setReloadKey(k => k + 1)}>Retry</button></section>
      : rows.length === 0 ? <section className="panel state">No data for this date range. Run <code>npm run seed</code> to load sample data.</section>
      : <>
        <section className="kpis">
          <article className="panel"><span className="muted">Revenue</span><strong>{money(totals.revenue)}</strong></article>
          <article className="panel"><span className="muted">Ad spend</span><strong>{money(totals.spend)}</strong></article>
          <article className="panel"><span className="muted">Blended ROAS</span><strong>{totals.roas === null ? "—" : `${totals.roas.toFixed(2)}×`}</strong></article>
          <article className="panel"><span className="muted">Orders</span><strong>{totals.orders.toLocaleString()}</strong></article>
        </section>

        <section className="panel chart">
          <div className="section-heading"><h2>ROAS trend</h2><p className="muted">Daily return on ad spend by channel</p></div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartRows}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" />
              <YAxis tickFormatter={v => `${v}×`} />
              <Tooltip formatter={(v: number) => (v === null ? "—" : `${Number(v).toFixed(2)}×`)} />
              <Legend />
              {chartChannels.map((c, i) => <Line key={c} type="monotone" dataKey={c} name={c} stroke={COLORS[i % COLORS.length]} strokeWidth={2.5} connectNulls dot={false} />)}
            </LineChart>
          </ResponsiveContainer>
        </section>

        <section className="panel">
          <h2>Attribution comparison</h2>
          <p className="muted">Revenue credited to each channel under three models. Linear splits each customer's revenue evenly across their touches.</p>
          {attribution.channels.length === 0 ? <p className="muted">No touchpoints in this range.</p> : <table>
            <thead><tr><th>Channel</th><th className="num">First touch</th><th className="num">Last touch</th><th className="num">Linear</th><th className="num">Touches</th><th className="num">Customers</th></tr></thead>
            <tbody>{attribution.channels.map(c => <tr key={c.channel}>
              <td>{c.channel}<div className="bar" style={{ width: `${(c.linear / maxLinear) * 100}%` }} /></td>
              <td className="num">{money(c.firstTouch)}</td>
              <td className="num">{money(c.lastTouch)}</td>
              <td className="num">{money(c.linear)}</td>
              <td className="num">{c.touches}</td>
              <td className="num">{c.customers}</td>
            </tr>)}</tbody>
          </table>}
          {attribution.journeys.length > 0 && <p className="legend">{attribution.journeys.map(j => <span key={j.touches}>{j.touches}-touch journeys: {j.customers} customers, {money(j.revenue)}</span>)}</p>}
        </section>
      </>}
    <footer>Commerce Analytics Engine</footer>
  </main>;
}
