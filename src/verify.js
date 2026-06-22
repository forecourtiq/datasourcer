// Verify a dealership is still trading by two independent signals:
//   1. Their own website footer mentions their (trading) name and/or a
//      registered company name / company number.
//   2. The FREE public Companies House website lists a matching company as
//      "active" (not dissolved) — scraped, no API key required.
//
// We read the company name + number from the footer, then look the company up
// on https://find-and-update.company-information.service.gov.uk and also emit a
// plain Google search of the company for manual cross-checking.

import * as cheerio from 'cheerio';
import { fetchText } from './http.js';

const CH_WEB = 'https://find-and-update.company-information.service.gov.uk';

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
// 2. Companies House check — scrapes the FREE public website (no API key).
//    https://find-and-update.company-information.service.gov.uk
// ---------------------------------------------------------------------------

/**
 * Resolve a company on the public Companies House website. Prefers a company
 * number scraped from the footer (authoritative); otherwise searches by name.
 */
export async function checkCompaniesHouse({ companyNumber, query } = {}) {
  const result = {
    queried: query || companyNumber || null,
    found: false,
    companyName: null,
    companyNumber: null,
    status: null, // active | dissolved | liquidation | ...
    isActive: false,
    profileUrl: null,
    searchUrl: query
      ? `${CH_WEB}/search/companies?q=${encodeURIComponent(query)}`
      : null,
  };

  // 1) If the footer gave us a number, look it up directly.
  if (companyNumber) {
    const byNumber = await lookupCompanyPublic(companyNumber);
    if (byNumber.found) return { ...result, ...byNumber };
  }

  // 2) Otherwise search by name and take the best match.
  if (query) {
    const match = await searchCompanyPublic(query);
    if (match) {
      const profile = await lookupCompanyPublic(match.companyNumber);
      if (profile.found) return { ...result, ...profile };
      return { ...result, found: true, ...match };
    }
  }
  return result;
}

/** Fetch + parse a company profile page from the public CH website. */
async function lookupCompanyPublic(number) {
  const base = { found: false };
  if (!number) return base;
  const profileUrl = `${CH_WEB}/company/${encodeURIComponent(number)}`;
  const res = await fetchText(profileUrl, { timeoutMs: 18000 });
  if (!res.ok || !res.body) return base;

  const $ = cheerio.load(res.body);
  const companyName =
    norm($('#company-name').first().text()) ||
    norm($('h1.heading-xlarge').first().text()) ||
    null;
  if (!companyName) return base; // likely a 404/error page

  const status =
    norm($('#company-status').first().text()).toLowerCase() ||
    extractStatusFromDl($) ||
    null;

  return {
    found: true,
    companyName,
    companyNumber: number,
    status,
    isActive: /active/.test(status || ''),
    profileUrl,
  };
}

/** Search the public CH website by name; returns the best {companyName, companyNumber}. */
async function searchCompanyPublic(query) {
  const url = `${CH_WEB}/search/companies?q=${encodeURIComponent(query)}`;
  const res = await fetchText(url, { timeoutMs: 18000 });
  if (!res.ok || !res.body) return null;

  const $ = cheerio.load(res.body);
  const candidates = [];
  $('a[href^="/company/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/^\/company\/([A-Z0-9]{6,8})\b/i);
    if (!m) return;
    const name = norm($(el).text());
    if (!name) return;
    candidates.push({ companyName: name, companyNumber: m[1] });
  });
  if (!candidates.length) return null;

  // Rank by name similarity to the query.
  candidates.sort((a, b) => similarity(query, b.companyName) - similarity(query, a.companyName));
  return candidates[0];
}

// Some profile pages render status inside the overview definition list rather
// than a dedicated #company-status node.
function extractStatusFromDl($) {
  let status = null;
  $('dt').each((_, el) => {
    if (status) return;
    if (/company status/i.test($(el).text())) {
      status = norm($(el).next('dd').text()).toLowerCase() || null;
    }
  });
  return status;
}

/**
 * Run the website-footer check + public Companies House lookup and produce a
 * "still trading" verdict plus a plain Google search of the company.
 */
export async function verifyDealer(dealer) {
  const footer = await checkWebsiteFooter(dealer.website, dealer.name);

  const query = footer.registeredNameOnSite || dealer.name;
  const ch = await checkCompaniesHouse({
    companyNumber: footer.companyNumberOnSite,
    query,
  });

  // Pull current officers (directors etc.) from the public website so we can
  // hunt for them individually on LinkedIn / Google.
  let officers = [];
  if (ch.found && ch.companyNumber) {
    officers = await fetchOfficers(ch.companyNumber);
  }

  // A plain Google search of the company, as requested.
  const googleSearch = buildCompanyGoogleSearch(
    ch.companyName || footer.registeredNameOnSite || dealer.name,
    ch.companyNumber || footer.companyNumberOnSite,
  );

  const verdict = decideTradingStatus(footer, ch);
  return { footer, companiesHouse: { ...ch, googleSearch }, officers, verdict };
}

/** A standard Google search for the company (name + number + "companies house"). */
export function buildCompanyGoogleSearch(name, number) {
  if (!name && !number) return null;
  const parts = [];
  if (name) parts.push(`"${name}"`);
  if (number) parts.push(number);
  parts.push('companies house');
  return `https://www.google.com/search?q=${encodeURIComponent(parts.join(' '))}`;
}

/**
 * Fetch the current (not-resigned) officers for a company by scraping the
 * public CH officers page. Names render as "LASTNAME, Firstname Middlenames";
 * we normalise to "Firstname Lastname" (first forename only) for searching.
 * @returns {Promise<Array<{name, naturalName, role, profileUrl}>>}
 */
export async function fetchOfficers(number) {
  if (!number) return [];
  const url = `${CH_WEB}/company/${encodeURIComponent(number)}/officers`;
  const res = await fetchText(url, { timeoutMs: 18000 });
  if (!res.ok || !res.body) return [];

  const $ = cheerio.load(res.body);
  const officers = [];
  const seen = new Set();

  // Each appointment links to /officers/<id>/appointments with the name as text.
  $('a[href^="/officers/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/\/officers\/[^/]+\/appointments/.test(href)) return;
    const rawName = norm($(el).text());
    if (!rawName) return;

    // Skip corporate officers (companies acting as director/secretary).
    if (/\b(LIMITED|LTD|PLC|LLP|SECRETARIES|NOMINEES)\b/i.test(rawName)) return;

    // Climb to the appointment container to read role + resignation status.
    const card = $(el).closest('div, li');
    const cardText = norm(card.text());
    if (/resigned on/i.test(cardText)) return; // current officers only

    const role = extractOfficerRole(card, $);

    const naturalName = naturaliseOfficerName(rawName);
    const key = naturalName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    officers.push({
      name: rawName,
      naturalName,
      role,
      profileUrl: `${CH_WEB}${href}`,
    });
  });

  return officers;
}

function extractOfficerRole(card, $) {
  // Role appears in a <dd id="officer-role-N"> or after a "Role" <dt>.
  const byId = norm(card.find('[id^="officer-role-"]').first().text());
  if (byId) return byId;
  let role = null;
  card.find('dt').each((_, dt) => {
    if (role) return;
    if (/^role$/i.test(norm($(dt).text()))) {
      role = norm($(dt).next('dd').text()) || null;
    }
  });
  return role;
}

// "SMITH, John David" -> "John Smith" (drop middle names for better search recall)
function naturaliseOfficerName(name) {
  if (!name) return null;
  const parts = name.split(',');
  if (parts.length === 2) {
    const last = titleCase(parts[0].trim());
    const first = parts[1].trim().split(/\s+/)[0] || ''; // first forename only
    return `${first} ${last}`.replace(/\s+/g, ' ').trim();
  }
  return name.trim();
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
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
