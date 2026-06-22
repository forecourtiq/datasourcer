// Small shared HTTP helper with browser-like headers, timeouts and retries.
// Many of the target sites (AutoTrader especially) reject requests that don't
// look like a real browser, so we send a full set of headers.

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

/**
 * Fetch a URL as text with timeout + simple retry/backoff.
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=20000]
 * @param {number} [opts.retries=2]
 * @param {object} [opts.headers]
 * @returns {Promise<{ok: boolean, status: number, url: string, body: string}>}
 */
export async function fetchText(url, opts = {}) {
  const { timeoutMs = 20000, retries = 2, headers = {} } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { ...DEFAULT_HEADERS, ...headers },
        redirect: 'follow',
        signal: controller.signal,
      });
      const body = await res.text();
      clearTimeout(timer);
      return { ok: res.ok, status: res.status, url: res.url, body };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(500 * Math.pow(2, attempt)); // 500ms, 1s, 2s ...
      }
    }
  }
  return { ok: false, status: 0, url, body: '', error: String(lastErr) };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalise a possibly-relative AutoTrader href to an absolute URL. */
export function absoluteUrl(href, base = 'https://www.autotrader.co.uk') {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
