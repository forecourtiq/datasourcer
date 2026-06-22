# Datasourcer 🚗

A web app that runs a UK car-dealership lead-sourcing workflow end to end:

1. **Find dealerships** via AutoTrader's dealer search (by postcode + radius).
2. **Verify they're still trading** by (a) fetching their website and reading the footer for their name + registered company name/number, and (b) looking that company up on the **free public Companies House website** (no API key) to confirm it's *active*. You also get a one-click **Google search** of the company for manual cross-checking.
3. **Surface sales-management contacts** by generating precise, ready-to-click **LinkedIn & Google searches** for Dealer Principals, Heads of Business, Sales Managers/Directors, Managing Directors, Operations Directors, and related roles.
4. **Look up the company's current officers** (directors) from the public Companies House officers page and generate a per-person LinkedIn + Google search for each, so you can research the named individuals directly.

Results stream into a live table in the browser and can be exported to **CSV**.

**No API keys required.**

---

## Quick start

```bash
npm install
npm start        # -> http://localhost:3000
```

Open <http://localhost:3000>, enter a postcode (e.g. `EX23 8AR`), pick a radius, and click **Find dealerships**. (Optionally `cp .env.example .env` to set a custom `PORT`.)

---

## How each step works

| Step | Source | Notes |
|------|--------|-------|
| Dealer search | `https://www.autotrader.co.uk/cars/dealers/search` | Parses the JSON embedded in the page first, falls back to scraping the rendered cards. AutoTrader changes its markup periodically and uses anti-bot measures — see *Limitations*. |
| Website footer | The dealer's own site | Looks for the dealer/trading name and a `Registered in England… company number 01234567` style line. |
| Trading status | **Free public Companies House website** (`find-and-update.company-information.service.gov.uk`) — no API key | Resolves the company by the footer's number (or by name search), reads its status, and treats `active` as trading; `dissolved`/`liquidation` as not. Combined with the footer signal into a confidence score. Also emits a plain Google search of the company (name + number + "companies house") and a Companies House search link for manual checking. |
| Contacts (roles) | Generated search URLs | We **do not** scrape LinkedIn (see below). The app builds Google `site:linkedin.com/in` searches and LinkedIn people searches scoped to the company name + target roles, plus a "contact page / email" search. |
| Officers | Public Companies House officers page | Scrapes the company's **current** officers (resigned and obvious corporate officers filtered out), normalises `LASTNAME, Firstname Middle` → `Firstname Lastname` (middle names dropped for better search recall), and generates a LinkedIn people search, a `site:linkedin.com/in` Google search, and an email/contact search for each named person. |

### Why we don't scrape LinkedIn for emails/phones

LinkedIn's terms forbid automated access, it blocks scrapers aggressively, and — most importantly — it **never exposes members' personal email addresses or phone numbers** to begin with. So the reliable, durable approach is to generate targeted searches you click through to read off names, then pull email/phone from the dealer's own *contact* / *meet the team* page (the "Contact/email" link does this).

If you later want fully-automated names + verified emails/phones, the clean way is to plug in a B2B enrichment provider (Apollo.io, Hunter.io, RocketReach, Lusha, etc.) with an API key. The code is structured so `src/linkedin.js` could be swapped for such a provider. Ask and this can be added.

Targeted roles (configurable in `src/linkedin.js`):
Dealer Principal · Head of Business · General Manager · Sales Manager · Head of Sales · Sales Director · Managing Director · Operations Director · Brand Manager · Used Car Manager · New Car Sales Manager · Transaction Manager · Business Manager.

---

## Project layout

```
server.js              Express server: static UI, /api/search (SSE), /api/csv
src/
  http.js              Browser-like fetch with timeout + retry
  autotrader.js        Dealer search scraper (JSON-first, DOM fallback)
  verify.js            Website-footer check + Companies House lookups + verdict
  linkedin.js          Generates LinkedIn/Google contact searches
  pipeline.js          Orchestrates the workflow, emits progress events
  csv.js               Flattens results to CSV
public/                index.html + app.js + styles.css (live results table)
test/                  Offline unit tests (no network needed)
```

Run the tests with `npm test`.

---

## Limitations & notes

- **AutoTrader anti-bot.** AutoTrader may serve a challenge page to non-browser requests, especially from datacentre/cloud IPs. If the results table is empty and the status bar warns about blocking, run it from a residential IP, lower the request rate, or front it with a headless browser. The parser tries multiple strategies and is easy to adjust in `src/autotrader.js`.
- **Markup changes.** The search and dealer-profile selectors are intentionally broad but will need occasional tuning as AutoTrader updates its site.
- **Rate limiting.** The pipeline throttles between dealers (`throttleMs`, default 600ms) to be polite. Keep volumes modest so the public Companies House website doesn't rate-limit you.
- **Public-site markup.** The Companies House profile/officers parsing targets the public `find-and-update` site and, like the AutoTrader parser, is written defensively but may need tuning if GOV.UK changes its markup.
- **Respect terms & data laws.** Use responsibly and in line with each site's terms and applicable data-protection law (e.g. UK GDPR / PECR) when contacting people.

---

## Configuration knobs

Set via the UI or query string on `/api/search`:

- `postcode` (required)
- `radius` — miles, 1–200 (default 200)
- `maxPages` — AutoTrader result pages to fetch, 1–10 (default 1)
- `maxDealers` — cap on dealers processed, 1–200 (default 50)

Server env: `PORT` (no API keys needed).
