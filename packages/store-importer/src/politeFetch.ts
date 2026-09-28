/**
 * Every request to someone else's store goes through here: one identifiable
 * User-Agent, a pause between requests, and a bounded retry on 429/5xx that
 * honors Retry-After. A store is a real business's server, not a test
 * fixture — the import must never look like a scrape storm.
 */

export const USER_AGENT = "ECM-Store-Importer/0.1 (+https://tapalog.com)";

export interface PoliteFetchOptions {
  /** Minimum gap between the start of two requests from this fetcher, ms. */
  minGapMs: number;
  retries: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export type PoliteFetch = (url: string) => Promise<Response>;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  // Capped, so one hostile header can't park the import for an hour.
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  return 1000 * 2 ** attempt;
}

export function createPoliteFetch(opts: PoliteFetchOptions): PoliteFetch {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  let nextSlot = 0;

  /** Serializes the pacing even when several downloads run at once. */
  async function waitForSlot() {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + opts.minGapMs;
    if (at > now) await sleep(at - now);
  }

  return async (url) => {
    for (let attempt = 0; ; attempt++) {
      await waitForSlot();
      let res: Response;
      try {
        res = await doFetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json, image/*;q=0.9, */*;q=0.5" },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
          redirect: "follow",
        });
      } catch (err) {
        if (attempt >= opts.retries) throw err;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= opts.retries) return res;
      await sleep(retryAfterMs(res, attempt));
    }
  };
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
