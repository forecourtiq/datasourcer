// AutoTrader dealer-search scraper.
//
// We hit the public dealer search page, e.g.:
//   https://www.autotrader.co.uk/cars/dealers/search?postcode=EX23%208AR&radius=200&...
//
// AutoTrader is a React/Next-style app, so the most reliable data source is the
// JSON blob embedded in the page (window.__INITIAL_STATE__ / __NEXT_DATA__ /
// application-ld+json). We try those first and fall back to parsing the
// rendered dealer cards from the HTML. Markup changes periodically, so the
// selectors below are intentionally broad and may need tuning over time.

import * as cheerio from 'cheerio';
import { fetchText, absoluteUrl } from './http.js';

const SEARCH_BASE = 'https://www.autotrader.co.uk/cars/dealers/search';

/**
 * Build an AutoTrader dealer-search URL from a postcode + radius.
 */
export function buildSearchUrl({ postcode, radius = 200, page = 1 }) {
  const params = new URLSearchParams({
    'advertising-locations': 'at_cars',
    dealerName: '',
    forSale: 'on',
    make: '',
    model: '',
    postcode: postcode,
    radius: String(radius),
    sort: 'with-retailer-reviews',
    toOrder: 'on',
  });
  if (page > 1) params.set('page', String(page));
  return `${SEARCH_BASE}?${params.toString()}`;
}

/**
 * Scrape one or more pages of dealer results.
 * @returns {Promise<{dealers: Array, pagesFetched: number, debug: object}>}
 */
export async function searchDealers({ postcode, radius = 200, maxPages = 1 }) {
  const all = new Map(); // dedupe by name+location
  const debug = { pages: [] };

  for (let page = 1; page <= maxPages; page++) {
    const url = buildSearchUrl({ postcode, radius, page });
    const res = await fetchText(url, { timeoutMs: 25000 });
    debug.pages.push({ url, status: res.status, bytes: res.body.length });

    if (!res.ok || !res.body) break;

    const dealers = parseDealers(res.body);
    for (const d of dealers) {
      const key = `${(d.name || '').toLowerCase()}|${(d.location || '').toLowerCase()}`;
      if (!all.has(key)) all.set(key, d);
    }
    // If a page returns nothing, assume we've run past the last results page.
    if (dealers.length === 0) break;
  }

  return { dealers: [...all.values()], pagesFetched: debug.pages.length, debug };
}

/**
 * Parse dealers from a search-results HTML document.
 * Tries embedded JSON first, then falls back to DOM parsing.
 */
export function parseDealers(html) {
  const fromJson = parseFromEmbeddedJson(html);
  if (fromJson.length) return fromJson;
  return parseFromDom(html);
}

// --- Strategy 1: embedded JSON state ----------------------------------------

function parseFromEmbeddedJson(html) {
  const dealers = [];
  const blobs = extractJsonBlobs(html);
  for (const blob of blobs) {
    walkForDealers(blob, dealers);
    if (dealers.length) break;
  }
  // Dedupe
  const seen = new Set();
  return dealers.filter((d) => {
    const k = `${d.name}|${d.location}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function extractJsonBlobs(html) {
  const blobs = [];
  const $ = cheerio.load(html);

  // __NEXT_DATA__
  const next = $('#__NEXT_DATA__').first().contents().text();
  if (next) tryPush(blobs, next);

  // window.__INITIAL_STATE__ = {...};  /  __APP_STATE__ etc.
  const stateRe =
    /window\.__(?:INITIAL_STATE|PRELOADED_STATE|APP_STATE|NUXT)__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/g;
  let m;
  while ((m = stateRe.exec(html)) !== null) tryPush(blobs, m[1]);

  // application/json script tags
  $('script[type="application/json"]').each((_, el) => {
    tryPush(blobs, $(el).contents().text());
  });

  return blobs;
}

function tryPush(arr, raw) {
  if (!raw) return;
  try {
    arr.push(JSON.parse(raw));
  } catch {
    /* not valid JSON, ignore */
  }
}

// Recursively look for objects that look like a dealer/retailer record.
function walkForDealers(node, out, depth = 0) {
  if (!node || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForDealers(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    const d = asDealer(node);
    if (d) out.push(d);
    for (const key of Object.keys(node)) {
      walkForDealers(node[key], out, depth + 1);
    }
  }
}

function asDealer(obj) {
  const name =
    obj.name || obj.dealerName || obj.retailerName || obj.tradingName || null;
  // Heuristic: a dealer object has a name plus location-ish/contact-ish fields.
  const looksLikeDealer =
    name &&
    (obj.postcode ||
      obj.town ||
      obj.location ||
      obj.address ||
      obj.dealerType ||
      obj.distance !== undefined ||
      obj.reviews !== undefined ||
      obj.rating !== undefined);
  if (!looksLikeDealer) return null;

  const location =
    obj.town ||
    obj.location ||
    obj.postcode ||
    (obj.address && (obj.address.town || obj.address.postcode)) ||
    '';

  const website =
    obj.website || obj.websiteUrl || obj.url || (obj.links && obj.links.website) || null;

  const autotraderUrl = absoluteUrl(
    obj.pageUrl || obj.profileUrl || obj.href || (obj.links && obj.links.profile) || null,
  );

  return {
    name: String(name).trim(),
    location: String(location).trim(),
    phone: obj.phoneNumber || obj.phone || obj.telephone || null,
    website: website ? absoluteUrl(website, 'https://') : null,
    autotraderUrl,
    rating: obj.rating || (obj.reviews && obj.reviews.rating) || null,
    source: 'json',
  };
}

// --- Strategy 2: DOM parsing of rendered cards ------------------------------

function parseFromDom(html) {
  const $ = cheerio.load(html);
  const dealers = [];
  const seen = new Set();

  // Dealer profile links typically look like /cars/dealers/<slug>-<id>
  $('a[href*="/dealers/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/\/dealers\/[^/]+-\d+/.test(href) && !/\/dealers\/\d+/.test(href)) return;

    // Climb to a card container so we can read the surrounding name/location.
    const card = $(el).closest('article, li, div');
    const name =
      cleanText($(el).text()) ||
      cleanText(card.find('h1,h2,h3,h4').first().text());
    if (!name) return;

    const location = cleanText(
      card.find('[class*="location" i], [class*="address" i], address').first().text(),
    );

    const key = `${name.toLowerCase()}|${location.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    dealers.push({
      name,
      location,
      phone: null,
      website: null,
      autotraderUrl: absoluteUrl(href),
      rating: null,
      source: 'dom',
    });
  });

  return dealers;
}

function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Visit a dealer's AutoTrader profile page to discover their external website
 * (the search results don't always include it).
 */
export async function findDealerWebsite(autotraderUrl) {
  if (!autotraderUrl) return null;
  const res = await fetchText(autotraderUrl, { timeoutMs: 20000 });
  if (!res.ok) return null;

  const $ = cheerio.load(res.body);
  // Look for an outbound "visit website" style link.
  let website = null;
  $('a[href^="http"]').each((_, el) => {
    if (website) return;
    const href = $(el).attr('href') || '';
    const label = (cleanText($(el).text()) + ' ' + ($(el).attr('rel') || '')).toLowerCase();
    if (/autotrader\.co\.uk/i.test(href)) return; // internal
    if (/visit (the )?website|dealer website|view website|website/.test(label)) {
      website = href;
    }
  });

  // Fallback: embedded JSON website field.
  if (!website) {
    const blobs = extractJsonBlobs(res.body);
    for (const b of blobs) {
      const found = findWebsiteInJson(b);
      if (found) {
        website = found;
        break;
      }
    }
  }
  return website ? absoluteUrl(website, 'https://') : null;
}

function findWebsiteInJson(node, depth = 0) {
  if (!node || depth > 12) return null;
  if (Array.isArray(node)) {
    for (const i of node) {
      const r = findWebsiteInJson(i, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (/website/i.test(key) && typeof node[key] === 'string' && /^https?:/.test(node[key])) {
        if (!/autotrader\.co\.uk/i.test(node[key])) return node[key];
      }
      const r = findWebsiteInJson(node[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
}
