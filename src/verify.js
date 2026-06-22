// Verify a dealership is still trading by two independent signals:
//   1. Their own website footer mentions their (trading) name and/or a
//      registered company name / company number.
//   2. Companies House lists a matching company as "active" (not dissolved).
//
// Companies House offers a free REST API. Set CH_API_KEY in the environment.
// Get a key at https://developer.company-information.service.gov.uk/

import * as cheerio from 'cheerio';
import { fetchText } from './http.js';

const CH_BASE = 'https://api.company-information.service.gov.uk';

// ---------------------------------------------------------------------------
// 1. Website footer check
// ---------------------------------------------------------------------------

/**
 * Fetch the dealership website and inspect the footer for their name and any
 * "Registered in England... company number 01234567" style legal text.
 */
export async function checkWebsiteFooter(website, dealerName) {
  const result = {
    website,
    reachable: false,
    nameInFooter: false,
    matchedText: null,
    companyNumberOnSite: null,
    registeredNameOnSite: null,
  };
  if (!website) return result;

  const res = await fetchText(website, { timeoutMs: 18000 });
  if (!res.ok || !res.body) return result;
  result.reachable = true;

  const $ = cheerio.load(res.body);
  const footer =
    $('footer').text() ||
    $('[class*="footer" i], #footer, [id*="footer" i]').text() ||
    $('body').text();
  const footerText = norm(footer);

  // Name match: try the full name and its distinctive tokens.
  const tokens = nameTokens(dealerName);
  for (const t of tokens) {
    if (t.length >= 3 && footerText.toLowerCase().includes(t.toLowerCase())) {
      result.nameInFooter = true;
      result.matchedText = snippet(footerText, t);
      break;
    }
  }

  // Company number: UK company numbers are 8 chars (often 8 digits, or 2
  // letters + 6 digits, e.g. SC123456).
  const numMatch = footerText.match(/\b((?:[A-Z]{2})?\d{6,8})\b/);
  if (numMatch && /\d{6}/.test(numMatch[1])) {
    // Bias towards numbers near "registered"/"company" wording.
    const ctx = footerText.toLowerCase();
    if (ctx.includes('registered') || ctx.includes('company')) {
      result.companyNumberOnSite = numMatch[1];
    }
  }

  // Registered name: "<Something> Limited/Ltd/PLC trading as ..."
  const regName = footerText.match(
    /([A-Z][A-Za-z0-9&'.,()\- ]+?\b(?:Limited|Ltd|PLC|LLP))\b/,
  );
  if (regName) result.registeredNameOnSite = regName[1].trim();

  return result;
}

// ---------------------------------------------------------------------------
// 2. Companies House check
// ---------------------------------------------------------------------------

/**
 * Search Companies House for a company matching the dealer/registered name and
 * report whether it's active.
 */
export async function checkCompaniesHouse(query, apiKey) {
  const result = {
    queried: query,
    available: Boolean(apiKey),
    found: false,
    companyName: null,
    companyNumber: null,
    status: null, // active | dissolved | liquidation | ...
    isActive: false,
    profileUrl: null,
  };
  if (!apiKey || !query) return result;

  const url = `${CH_BASE}/search/companies?q=${encodeURIComponent(query)}&items_per_page=5`;
  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
  const res = await fetchText(url, {
    timeoutMs: 15000,
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!res.ok || !res.body) return result;

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    return result;
  }
  const items = data.items || [];
  if (!items.length) return result;

  // Prefer the best name match, favouring active companies.
  const ranked = items
    .map((it) => ({ it, score: similarity(query, it.title || '') + (it.company_status === 'active' ? 0.15 : 0) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0].it;

  result.found = true;
  result.companyName = best.title || null;
  result.companyNumber = best.company_number || null;
  result.status = best.company_status || null;
  result.isActive = best.company_status === 'active';
  result.profileUrl = best.company_number
    ? `https://find-and-update.company-information.service.gov.uk/company/${best.company_number}`
    : null;
  return result;
}

/**
 * Run both checks and produce an overall "still trading" verdict.
 */
export async function verifyDealer(dealer, { chApiKey } = {}) {
  const footer = await checkWebsiteFooter(dealer.website, dealer.name);

  // Query Companies House with the most specific name we have.
  const chQuery = footer.registeredNameOnSite || dealer.name;
  const ch = await checkCompaniesHouse(chQuery, chApiKey);

  // If the site gave us a company number, that's authoritative — fetch it.
  let chByNumber = null;
  if (footer.companyNumberOnSite && chApiKey) {
    chByNumber = await lookupCompanyByNumber(footer.companyNumberOnSite, chApiKey);
  }
  const chFinal = chByNumber && chByNumber.found ? chByNumber : ch;

  const verdict = decideTradingStatus(footer, chFinal);
  return { footer, companiesHouse: chFinal, verdict };
}

async function lookupCompanyByNumber(number, apiKey) {
  const url = `${CH_BASE}/company/${encodeURIComponent(number)}`;
  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
  const res = await fetchText(url, {
    timeoutMs: 15000,
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!res.ok) return { found: false };
  try {
    const c = JSON.parse(res.body);
    return {
      found: true,
      companyName: c.company_name || null,
      companyNumber: c.company_number || number,
      status: c.company_status || null,
      isActive: c.company_status === 'active',
      profileUrl: `https://find-and-update.company-information.service.gov.uk/company/${c.company_number || number}`,
    };
  } catch {
    return { found: false };
  }
}

function decideTradingStatus(footer, ch) {
  // active CH record is the strongest signal; a reachable site with the name
  // in the footer is a good secondary signal.
  if (ch.found && ch.isActive) {
    return { tradingLikely: true, confidence: 'high', reason: 'Companies House lists company as active' };
  }
  if (ch.found && !ch.isActive) {
    return {
      tradingLikely: false,
      confidence: 'high',
      reason: `Companies House status: ${ch.status || 'not active'}`,
    };
  }
  if (footer.reachable && footer.nameInFooter) {
    return { tradingLikely: true, confidence: 'medium', reason: 'Live website with dealer name in footer' };
  }
  if (footer.reachable) {
    return { tradingLikely: true, confidence: 'low', reason: 'Website reachable but name not confirmed in footer' };
  }
  return { tradingLikely: false, confidence: 'low', reason: 'Website unreachable and no Companies House match' };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Meaningful tokens of a dealer name (drop generic words).
function nameTokens(name) {
  const stop = new Set([
    'ltd', 'limited', 'plc', 'llp', 'the', 'and', 'cars', 'car', 'motors',
    'motor', 'group', 'co', 'company', 'trading', 'as', 'of', 'uk',
  ]);
  const full = norm(name);
  const words = full
    .replace(/[(),.]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stop.has(w.toLowerCase()));
  // Return the full name first, then the longest distinctive single tokens.
  return [full, ...words.sort((a, b) => b.length - a.length)];
}

function snippet(text, term) {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + term.length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// Cheap token-overlap similarity for ranking name matches (0..1).
function similarity(a, b) {
  const ta = new Set(norm(a).toLowerCase().split(/\s+/));
  const tb = new Set(norm(b).toLowerCase().split(/\s+/));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}
