/**
 * Minimal in-memory fixed-window rate limiter — enough to blunt
 * brute-force attempts on the login endpoint of a small self-hosted
 * server. Per-instance and reset on restart by design; heavier
 * protection belongs to the reverse proxy in front (see README).
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Sloppy periodic sweep so the map cannot grow unbounded. */
function sweep(now: number): void {
  if (buckets.size < 10_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** Record one attempt; returns false when the key is over budget. */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, {count: 1, resetAt: now + windowMs});
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

/** Best-effort client IP for keying: x-forwarded-for first (we sit
 * behind a reverse proxy in the documented deployment), then the Node
 * socket info Next injects. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return (
    (req as Request & {socket?: {remoteAddress?: string}}).socket
      ?.remoteAddress ?? "unknown"
  );
}
