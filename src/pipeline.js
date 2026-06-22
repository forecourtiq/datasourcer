// Orchestrates the full workflow for one search and emits progress events so
// the frontend can stream results live.
//
//   1. AutoTrader dealer search (postcode + radius)
//   2. For each dealer: resolve website, verify trading (footer + Companies House)
//   3. Generate LinkedIn / contact search links for sales-management roles
//
// `onEvent` is called with { type, ... } objects throughout.

import { searchDealers, findDealerWebsite } from './autotrader.js';
import { verifyDealer } from './verify.js';
import { buildContactSearches } from './linkedin.js';
import { sleep } from './http.js';

export async function runPipeline(
  { postcode, radius = 200, maxPages = 1, maxDealers = 50, chApiKey, throttleMs = 600 },
  onEvent = () => {},
) {
  onEvent({ type: 'status', message: `Searching AutoTrader for dealers near ${postcode} (within ${radius} miles)…` });

  const { dealers, debug } = await searchDealers({ postcode, radius, maxPages });
  onEvent({ type: 'search-complete', count: dealers.length, debug });

  if (dealers.length === 0) {
    onEvent({
      type: 'warning',
      message:
        'No dealers parsed from AutoTrader. The page may have been blocked (anti-bot) or its markup changed. See server logs / debug.',
    });
  }

  const limited = dealers.slice(0, maxDealers);
  const results = [];

  for (let i = 0; i < limited.length; i++) {
    const dealer = limited[i];
    onEvent({
      type: 'dealer-start',
      index: i,
      total: limited.length,
      name: dealer.name,
    });

    // Resolve external website if we only have the AutoTrader profile.
    if (!dealer.website && dealer.autotraderUrl) {
      try {
        dealer.website = await findDealerWebsite(dealer.autotraderUrl);
      } catch {
        /* non-fatal */
      }
    }

    // Verify trading status.
    let verification;
    try {
      verification = await verifyDealer(dealer, { chApiKey });
    } catch (err) {
      verification = { error: String(err), verdict: { tradingLikely: null, confidence: 'unknown', reason: 'verification error' } };
    }

    // Contact search links.
    const contacts = buildContactSearches({
      dealerName: dealer.name,
      registeredName:
        (verification.companiesHouse && verification.companiesHouse.companyName) ||
        (verification.footer && verification.footer.registeredNameOnSite) ||
        null,
      location: dealer.location,
    });

    const record = {
      name: dealer.name,
      location: dealer.location,
      phone: dealer.phone,
      website: dealer.website,
      autotraderUrl: dealer.autotraderUrl,
      rating: dealer.rating,
      registeredName:
        (verification.companiesHouse && verification.companiesHouse.companyName) || null,
      companyNumber:
        (verification.companiesHouse && verification.companiesHouse.companyNumber) || null,
      companyStatus:
        (verification.companiesHouse && verification.companiesHouse.status) || null,
      companiesHouseUrl:
        (verification.companiesHouse && verification.companiesHouse.profileUrl) || null,
      nameInFooter: verification.footer ? verification.footer.nameInFooter : false,
      footerMatch: verification.footer ? verification.footer.matchedText : null,
      tradingLikely: verification.verdict.tradingLikely,
      confidence: verification.verdict.confidence,
      verdictReason: verification.verdict.reason,
      contacts,
    };
    results.push(record);

    onEvent({ type: 'dealer-result', index: i, total: limited.length, record });

    if (i < limited.length - 1 && throttleMs) await sleep(throttleMs);
  }

  onEvent({ type: 'done', count: results.length });
  return results;
}
