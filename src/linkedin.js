// Generate targeted search URLs for finding sales-management contacts at a
// dealership on LinkedIn.
//
// We deliberately do NOT scrape LinkedIn: it forbids automated access, blocks
// it aggressively, and never exposes personal email/phone anyway. Instead we
// produce ready-to-click searches the user can run in a browser:
//   - a Google "site:linkedin.com/in" search (best for surfacing profiles)
//   - LinkedIn's own people search (requires being logged in)
//   - a Bing fallback
// plus generic company lookups (LinkedIn company page, Google) so the user can
// pull email/phone from the dealer's own contact page where available.

// Sales-management roles the workflow targets.
export const TARGET_ROLES = [
  'Dealer Principal',
  'Head of Business',
  'General Manager',
  'Sales Manager',
  'Head of Sales',
  'Sales Director',
  'Managing Director',
  'Operations Director',
  'Brand Manager',
  'Used Car Manager',
  'New Car Sales Manager',
  'Transaction Manager',
  'Business Manager',
];

/**
 * Build the set of search links for a dealership.
 * @param {object} args
 * @param {string} args.dealerName        e.g. "Bassetts Nissan Bridgend"
 * @param {string} [args.registeredName]  e.g. "Bassetts (South Wales) Limited"
 * @param {string} [args.location]        town/postcode to disambiguate
 */
export function buildContactSearches({ dealerName, registeredName, location } = {}) {
  const names = uniq([dealerName, registeredName].filter(Boolean));
  const namesClause = names.map((n) => `"${n}"`).join(' OR ');
  const rolesClause = TARGET_ROLES.map((r) => `"${r}"`).join(' OR ');

  // People search (profiles)
  const googleProfiles = google(
    `site:linkedin.com/in (${namesClause}) (${rolesClause})`,
  );
  const bingProfiles = bing(
    `site:linkedin.com/in (${namesClause}) (${rolesClause})`,
  );

  // LinkedIn native people search, keyword-scoped to the company name + roles.
  const liKeywords = `${names[0] || ''} (${TARGET_ROLES.slice(0, 6).join(' OR ')})`;
  const linkedinPeople = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
    liKeywords,
  )}`;

  // Company page lookups (to then browse the company's "People" tab)
  const linkedinCompany = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(
    names[0] || '',
  )}`;
  const googleCompanyLinkedIn = google(
    `site:linkedin.com/company "${names[0] || ''}"`,
  );

  // Help find an email/phone from the dealer's own contact page.
  const contactPageSearch = google(
    `(${namesClause}) (contact OR "meet the team" OR management) ${location || ''} email`,
  );

  // Per-role profile searches for precision.
  const perRole = TARGET_ROLES.map((role) => ({
    role,
    google: google(`site:linkedin.com/in (${namesClause}) "${role}"`),
    linkedin: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
      `${names[0] || ''} ${role}`,
    )}`,
  }));

  return {
    targetRoles: TARGET_ROLES,
    primary: {
      googleProfiles,
      linkedinPeople,
      bingProfiles,
    },
    company: {
      linkedinCompany,
      googleCompanyLinkedIn,
      contactPageSearch,
    },
    perRole,
  };
}

function google(q) {
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
function bing(q) {
  return `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
}
function uniq(arr) {
  return [...new Set(arr)];
}
