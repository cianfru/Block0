// ABUSE GUARDS for the public API — the thing that keeps one scraper (or one hostile visitor in a loop) from
// saturating the free native RPC that the whole cost model rests on. Three small, pure, injectable primitives:
//
//   • makeLimiter   — per-key (per-IP) token bucket. Burst `capacity`, refills `perSec`. take(key) → {ok, retryAfterSec}.
//   • makeCoalescer — identical concurrent requests share ONE in-flight promise (a stampede of 50 tabs on the same
//                     token costs one reconstruction, not fifty).
//   • makeSemaphore — a global cap on how many RPC-heavy handlers run at once; beyond it callers get a fast
//                     "busy, retry" instead of piling onto the RPC.
//
// Memory is bounded: idle buckets are swept. Everything takes an injectable clock so it's unit-testable.

export function makeLimiter({ capacity = 30, perSec = 0.5, now = Date.now, maxKeys = 20000 } = {}) {
  const buckets = new Map();   // key -> { tokens, at }
  let lastSweep = now();
  const sweep = (t) => {       // drop buckets that have fully refilled and sat idle — bounded memory
    if (t - lastSweep < 60000 && buckets.size < maxKeys) return;
    lastSweep = t;
    const idleMs = (capacity / perSec) * 1000;
    for (const [k, b] of buckets) if (t - b.at > idleMs) buckets.delete(k);
  };
  return {
    take(key, cost = 1) {
      const t = now(); sweep(t);
      let b = buckets.get(key);
      if (!b) { b = { tokens: capacity, at: t }; buckets.set(key, b); }
      const refill = ((t - b.at) / 1000) * perSec;
      b.tokens = Math.min(capacity, b.tokens + refill); b.at = t;
      if (b.tokens >= cost) { b.tokens -= cost; return { ok: true, remaining: Math.floor(b.tokens) }; }
      const retryAfterSec = Math.max(1, Math.ceil((cost - b.tokens) / perSec));
      return { ok: false, retryAfterSec, remaining: 0 };
    },
    size: () => buckets.size,
  };
}

export function makeCoalescer() {
  const inflight = new Map();  // key -> promise
  return {
    run(key, fn) {
      const cur = inflight.get(key); if (cur) return cur;
      const p = Promise.resolve().then(fn).finally(() => { inflight.delete(key); });
      inflight.set(key, p);
      return p;
    },
    inflight: () => inflight.size,
  };
}

export function makeSemaphore(max = 6) {
  let active = 0;
  return {
    tryAcquire() { if (active >= max) return null; active++; let done = false; return () => { if (!done) { done = true; active--; } }; },
    active: () => active, max,
  };
}

// The client IP behind a proxy (Railway/Cloudflare set x-forwarded-for; first hop is the client). Falls back to socket.
export function clientIp(req) {
  const xf = req.headers && req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim().slice(0, 64);
  const cf = req.headers && req.headers["cf-connecting-ip"]; if (typeof cf === "string" && cf.length) return cf.slice(0, 64);
  return (req.socket && req.socket.remoteAddress) || "unknown";
}
