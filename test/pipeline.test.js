// Offline tests for the parsing / link-generation logic (no network needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDealers, buildSearchUrl } from '../src/autotrader.js';
import { checkWebsiteFooter, fetchOfficers } from '../src/verify.js';
import { buildContactSearches, buildPersonSearches, TARGET_ROLES } from '../src/linkedin.js';
import { toCsv } from '../src/csv.js';

test('buildSearchUrl encodes postcode and radius', () => {
  const url = buildSearchUrl({ postcode: 'EX23 8AR', radius: 200 });
  assert.match(url, /postcode=EX23\+8AR/);
  assert.match(url, /radius=200/);
  assert.match(url, /sort=with-retailer-reviews/);
});

test('parseDealers extracts from embedded __NEXT_DATA__ JSON', () => {
  const html = `<html><body>
    <script id="__NEXT_DATA__" type="application/json">
    ${JSON.stringify({
      props: {
        pageProps: {
          results: [
            { dealerName: 'Bassetts Nissan Bridgend', town: 'Bridgend', postcode: 'CF31 3RT', rating: 4.7, distance: 12, pageUrl: '/cars/dealers/bassetts-nissan-12345' },
            { name: 'Cardiff Audi', town: 'Cardiff', distance: 18, reviews: { rating: 4.5 } },
          ],
        },
      },
    })}
    </script>
  </body></html>`;
  const dealers = parseDealers(html);
  const names = dealers.map((d) => d.name);
  assert.ok(names.includes('Bassetts Nissan Bridgend'), 'finds Bassetts');
  assert.ok(names.includes('Cardiff Audi'), 'finds Cardiff Audi');
  const bassetts = dealers.find((d) => d.name === 'Bassetts Nissan Bridgend');
  assert.equal(bassetts.location, 'Bridgend');
  assert.match(bassetts.autotraderUrl, /autotrader\.co\.uk\/cars\/dealers\/bassetts-nissan-12345/);
});

test('parseDealers falls back to DOM card parsing', () => {
  const html = `<html><body>
    <article>
      <h3><a href="/cars/dealers/some-garage-99887">Some Garage Ltd</a></h3>
      <span class="location">Exeter, Devon</span>
    </article>
  </body></html>`;
  const dealers = parseDealers(html);
  assert.equal(dealers.length, 1);
  assert.equal(dealers[0].name, 'Some Garage Ltd');
  assert.equal(dealers[0].source, 'dom');
});

test('checkWebsiteFooter detects name + company number (mocked fetch)', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://example.com',
    text: async () =>
      `<html><body><footer>
        Bassetts (South Wales) Limited trading as Bassetts Nissan Bridgend.
        Registered in England and Wales, company number 01234567.
      </footer></body></html>`,
  });
  try {
    const r = await checkWebsiteFooter('https://example.com', 'Bassetts Nissan Bridgend');
    assert.equal(r.reachable, true);
    assert.equal(r.nameInFooter, true);
    assert.equal(r.companyNumberOnSite, '01234567');
    assert.match(r.registeredNameOnSite, /Bassetts \(South Wales\) Limited/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('buildContactSearches targets all sales roles and both names', () => {
  const c = buildContactSearches({
    dealerName: 'Bassetts Nissan Bridgend',
    registeredName: 'Bassetts (South Wales) Limited',
    location: 'Bridgend',
  });
  assert.deepEqual(c.targetRoles, TARGET_ROLES);
  assert.match(decodeURIComponent(c.primary.googleProfiles), /site:linkedin\.com\/in/);
  assert.match(decodeURIComponent(c.primary.googleProfiles), /Bassetts Nissan Bridgend/);
  assert.match(decodeURIComponent(c.primary.googleProfiles), /Bassetts \(South Wales\) Limited/);
  assert.match(decodeURIComponent(c.primary.googleProfiles), /Dealer Principal/);
  assert.equal(c.perRole.length, TARGET_ROLES.length);
});

test('fetchOfficers returns current officers, naturalises names, drops resigned/corporate', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://api',
    text: async () =>
      JSON.stringify({
        items: [
          {
            name: 'SMITH, John David',
            officer_role: 'director',
            appointed_on: '2015-01-01',
            occupation: 'Company Director',
            links: { officer: { appointments: '/officers/abc123/appointments' } },
          },
          { name: 'JONES, Sarah', officer_role: 'director', resigned_on: '2020-05-01' }, // resigned -> dropped
          { name: 'CORPORATE NOMINEES LIMITED', officer_role: 'secretary' }, // corporate -> dropped
        ],
      }),
  });
  try {
    const officers = await fetchOfficers('01234567', 'key');
    assert.equal(officers.length, 1);
    assert.equal(officers[0].naturalName, 'John David Smith');
    assert.equal(officers[0].role, 'director');
    assert.match(officers[0].profileUrl, /\/officers\/abc123\/appointments$/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('buildPersonSearches scopes a named person by company', () => {
  const s = buildPersonSearches({ personName: 'John Smith', companyName: 'Bassetts (South Wales) Limited', location: 'Bridgend' });
  assert.match(decodeURIComponent(s.googleProfile), /site:linkedin\.com\/in "John Smith"/);
  assert.match(decodeURIComponent(s.googleProfile), /Bassetts \(South Wales\) Limited/);
  assert.match(decodeURIComponent(s.linkedinPeople), /John Smith/);
  assert.match(decodeURIComponent(s.googleGeneral), /email OR contact OR phone/);
  assert.equal(buildPersonSearches({}), null);
});

test('toCsv produces a header and escapes commas/quotes', () => {
  const csv = toCsv([
    {
      name: 'Bassetts, Nissan',
      location: 'Bridgend',
      tradingLikely: true,
      confidence: 'high',
      contacts: buildContactSearches({ dealerName: 'Bassetts' }),
    },
  ]);
  const lines = csv.split('\r\n');
  assert.match(lines[0], /Dealer Name/);
  assert.match(lines[1], /"Bassetts, Nissan"/); // comma escaped
  assert.match(lines[1], /true/);
});
