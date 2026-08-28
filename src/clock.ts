import { info, warn } from "./logger";

// The machine clock may drift or be plain wrong. Mint timing is absolute, so a
// skewed clock fires late or early regardless of how carefully the target is
// chosen. We measure skew against public time sources once and apply it
// everywhere instead of trusting Date.now() blindly.

let skewMs: number | null = null;

interface Source {
  url: string;
  parse: (body: string, headers: Headers) => number | null;
}

const SOURCES: Source[] = [
  {
    // Cloudflare edge trace: `ts=<unix seconds>` line.
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    parse: (body) => {
      const m = /^ts=(\d+)$/m.exec(body);
      return m ? Number(m[1]) * 1000 : null;
    },
  },
  {
    // worldtimeapi JSON: `unixtime` field (UTC epoch seconds).
    url: "https://worldtimeapi.org/api/timezone/Etc/UTC",
    parse: (body) => {
      try {
        const j = JSON.parse(body);
        return typeof j.unixtime === "number" ? j.unixtime * 1000 : null;
      } catch {
        return null;
      }
    },
  },
];

// Fetch one source and estimate skew = (true now) − (machine now).
// Latency is split evenly: the server timestamp is treated as the time at the
// midpoint of the round trip, so skew ≈ serverTs − midpoint.
async function measureOne(src: Source, timeoutMs = 4000): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const t0 = Date.now();
    const res = await fetch(src.url, { signal: ctrl.signal });
    const t1 = Date.now();
    const body = await res.text();
    const serverMs = src.parse(body, res.headers);
    if (serverMs === null) return null;
    return serverMs - (t0 + t1) / 2;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncClock(toleranceMs = 2000): Promise<void> {
  const results: number[] = [];
  for (const src of SOURCES) {
    const s = await measureOne(src);
    if (s !== null && Number.isFinite(s)) results.push(s);
  }

  if (results.length === 0) {
    skewMs = 0;
    warn("Time source unreachable — using system clock unadjusted.");
    return;
  }

  results.sort((a, b) => a - b);
  const median = results[Math.floor(results.length / 2)];
  skewMs = median;

  const secs = median / 1000;
  if (Math.abs(median) > toleranceMs) {
    warn(`System clock off by ${secs.toFixed(1)}s — applying correction.`);
  } else {
    info(`Clock skew ${secs.toFixed(2)}s — within tolerance.`);
  }
}

// Corrected epoch milliseconds. Falls back to the raw clock until synced.
export function nowMs(): number {
  return Date.now() + (skewMs ?? 0);
}

export function correctedNow(): Date {
  return new Date(nowMs());
}
