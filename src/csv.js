// Flatten pipeline result records into a CSV string.

const COLUMNS = [
  ['name', 'Dealer Name'],
  ['location', 'Location'],
  ['phone', 'Phone (AutoTrader)'],
  ['website', 'Website'],
  ['autotraderUrl', 'AutoTrader Profile'],
  ['rating', 'Rating'],
  ['tradingLikely', 'Trading Likely'],
  ['confidence', 'Confidence'],
  ['verdictReason', 'Verdict Reason'],
  ['nameInFooter', 'Name In Footer'],
  ['registeredName', 'Registered Company'],
  ['companyNumber', 'Company Number'],
  ['companyStatus', 'Companies House Status'],
  ['companiesHouseUrl', 'Companies House URL'],
  ['companyGoogleSearch', 'Company Google Search'],
  ['googleProfiles', 'LinkedIn Profiles (Google)'],
  ['linkedinPeople', 'LinkedIn People Search'],
  ['contactPageSearch', 'Contact Page Search'],
  ['targetRoles', 'Target Roles'],
  ['officers', 'CH Officers (name · role)'],
];

export function toCsv(records) {
  const header = COLUMNS.map(([, label]) => label).join(',');
  const rows = records.map((r) => {
    const flat = flatten(r);
    return COLUMNS.map(([key]) => escapeCell(flat[key])).join(',');
  });
  return [header, ...rows].join('\r\n');
}

function flatten(r) {
  const c = r.contacts || {};
  const primary = c.primary || {};
  const company = c.company || {};
  return {
    ...r,
    googleProfiles: primary.googleProfiles || '',
    linkedinPeople: primary.linkedinPeople || '',
    contactPageSearch: company.contactPageSearch || '',
    targetRoles: Array.isArray(c.targetRoles) ? c.targetRoles.join('; ') : '',
    officers: Array.isArray(r.officers)
      ? r.officers.map((o) => `${o.name}${o.role ? ' · ' + o.role : ''}`).join('; ')
      : '',
  };
}

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
