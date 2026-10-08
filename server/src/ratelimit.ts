/** Rate limiting + client-identity helpers shared by the MCP surface and the OAuth
 * endpoints. */

import type { Context } from "hono";

// X-Forwarded-For client IP, counting from the RIGHT by the number of trusted proxy hops
// in front of this process. The edge (Railway = 1 hop) APPENDS the real client IP to the
// right and never strips client-supplied values, so anything left of the trusted tail is
// attacker-controlled (rotate it per request -> a fresh limiter bucket every guess).
// AGATE_TRUST_PROXY_HOPS overrides the hop count for other ingress topologies (CDN/WAF
// in front => 2); 0 disables XFF trust entirely (direct/loopback exposure).
export const clientIp = (c: Context): string => {
  const raw = process.env.AGATE_TRUST_PROXY_HOPS;
  const hops = raw === undefined || raw.trim() === "" || !Number.isFinite(Number(raw)) ? 1 : Math.max(0, Number(raw));
  if (hops > 0) {
    const xff = c.req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
    if (xff && xff.length) return xff[Math.max(0, xff.length - hops)]!;
  }
  return c.req.header("x-real-ip") || "unknown";
};

/** Tiny in-memory sliding-window limiter (single process; no dep). Keyed by
 * client IP for unauthenticated attempts, and by AI connection for authed load. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  /** returns true if ALLOWED, false if the key is over its limit for the window */
  allow(key: string, nowMs: number): boolean {
    const cutoff = nowMs - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(nowMs);
    this.hits.set(key, arr);
    // opportunistic GC so the map can't grow unbounded, at most once per window: a sweep on every call would cost
    // a full scan per request while many keys are live
    if (this.hits.size > 5000 && nowMs - this.lastSweep >= this.windowMs) {
      this.lastSweep = nowMs;
      for (const [k, v] of this.hits) if (v.every((t) => t <= cutoff)) this.hits.delete(k);
    }
    return true;
  }
}
