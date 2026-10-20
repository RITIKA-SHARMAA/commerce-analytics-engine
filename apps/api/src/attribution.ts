export type Touch = { channel: string; occurredAt: Date | string };
export function attributeRevenue(touches: Touch[], revenue: number) {
  if (!touches.length) return { firstTouch: {}, lastTouch: {}, linear: {} };
  const ordered = [...touches].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  const first: Record<string, number> = {}, last: Record<string, number> = {}, linear: Record<string, number> = {};
  first[ordered[0].channel] = (first[ordered[0].channel] ?? 0) + revenue;
  last[ordered[ordered.length - 1].channel] = (last[ordered[ordered.length - 1].channel] ?? 0) + revenue;
  const share = revenue / ordered.length;
  for (const touch of ordered) linear[touch.channel] = (linear[touch.channel] ?? 0) + share;
  return { firstTouch: first, lastTouch: last, linear };
}
