// Frontend logic: kick off an SSE search, render rows live, export CSV.

const form = document.getElementById('searchForm');
const goBtn = document.getElementById('goBtn');
const csvBtn = document.getElementById('csvBtn');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const tbody = document.getElementById('resultsBody');
const chBadge = document.getElementById('chBadge');

let records = [];
let evtSource = null;

// Show whether Companies House is configured server-side.
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    if (h.companiesHouseConfigured) {
      chBadge.textContent = 'Companies House: connected';
      chBadge.className = 'badge badge-ok';
    } else {
      chBadge.textContent = 'Companies House: not configured';
      chBadge.className = 'badge badge-warn';
      chBadge.title = 'Set CH_API_KEY on the server to enable active-company checks';
    }
  })
  .catch(() => {});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  startSearch();
});

csvBtn.addEventListener('click', downloadCsv);

function startSearch() {
  if (evtSource) evtSource.close();
  records = [];
  tbody.innerHTML = '';
  csvBtn.disabled = true;
  goBtn.disabled = true;

  const params = new URLSearchParams({
    postcode: document.getElementById('postcode').value.trim(),
    radius: document.getElementById('radius').value,
    maxPages: document.getElementById('maxPages').value,
    maxDealers: document.getElementById('maxDealers').value,
  });

  setStatus('Connecting…');
  evtSource = new EventSource(`/api/search?${params.toString()}`);

  evtSource.onmessage = (msg) => {
    let ev;
    try { ev = JSON.parse(msg.data); } catch { return; }
    handleEvent(ev);
  };
  evtSource.onerror = () => {
    // EventSource fires error on normal stream close too; only surface if mid-run.
    if (goBtn.disabled) finish('Connection closed.');
  };
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'status':
      setStatus(ev.message);
      break;
    case 'search-complete':
      setStatus(`Found ${ev.count} dealer(s). Verifying & sourcing contacts…`);
      break;
    case 'warning':
      setStatus('⚠️ ' + ev.message);
      break;
    case 'dealer-start':
      progressEl.textContent = `Processing ${ev.index + 1} / ${ev.total}: ${ev.name}`;
      break;
    case 'dealer-result':
      addRow(ev.record);
      records.push(ev.record);
      csvBtn.disabled = records.length === 0;
      break;
    case 'error':
      setStatus('❌ Error: ' + ev.message);
      finish();
      break;
    case 'done':
      finish(`Done — ${ev.count} dealership(s) processed.`);
      break;
  }
}

function finish(msg) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  goBtn.disabled = false;
  progressEl.textContent = '';
  if (msg) setStatus(msg);
  csvBtn.disabled = records.length === 0;
}

function setStatus(text) { statusEl.textContent = text; }

function addRow(r) {
  const tr = document.createElement('tr');

  const trading = tradingPill(r.tradingLikely);
  const chCell = r.companyNumber
    ? `<a href="${esc(r.companiesHouseUrl)}" target="_blank" rel="noopener">${esc(r.registeredName || r.companyNumber)}</a>
       <span class="conf">${esc(r.companyStatus || '')} · ${esc(r.companyNumber)}</span>`
    : '<span class="muted">no match</span>';

  const websiteCell = r.website
    ? `<a href="${esc(r.website)}" target="_blank" rel="noopener">${esc(hostname(r.website))}</a>
       ${r.nameInFooter ? '<span class="conf">✓ name in footer</span>' : '<span class="conf">footer not confirmed</span>'}`
    : '<span class="muted">unknown</span>';

  const c = r.contacts || {};
  const primary = c.primary || {};
  const company = c.company || {};
  const perRole = Array.isArray(c.perRole) ? c.perRole : [];

  const roleLinks = perRole
    .map((pr) => `<a href="${esc(pr.google)}" target="_blank" rel="noopener">${esc(pr.role)}</a>`)
    .join('');

  const contactsCell = `
    <div class="linkcol">
      <a href="${esc(primary.googleProfiles)}" target="_blank" rel="noopener">🔎 Google profiles</a>
      <a href="${esc(primary.linkedinPeople)}" target="_blank" rel="noopener">in People search</a>
      <a href="${esc(company.contactPageSearch)}" target="_blank" rel="noopener">✉️ Contact/email</a>
    </div>
    <details class="role-links">
      <summary>By role (${perRole.length})</summary>
      ${roleLinks}
    </details>`;

  tr.innerHTML = `
    <td>
      <div class="dealer-name">${esc(r.name)}</div>
      ${r.autotraderUrl ? `<a class="muted" href="${esc(r.autotraderUrl)}" target="_blank" rel="noopener">AutoTrader profile</a>` : ''}
      ${r.phone ? `<div class="muted">${esc(r.phone)}</div>` : ''}
    </td>
    <td>${esc(r.location || '')}</td>
    <td>${trading}<span class="conf">${esc(r.confidence || '')} · ${esc(r.verdictReason || '')}</span></td>
    <td>${chCell}</td>
    <td>${websiteCell}</td>
    <td>${contactsCell}</td>`;

  tbody.appendChild(tr);
}

function tradingPill(val) {
  if (val === true) return '<span class="pill pill-yes">Trading</span>';
  if (val === false) return '<span class="pill pill-no">Not trading</span>';
  return '<span class="pill pill-maybe">Unknown</span>';
}

async function downloadCsv() {
  const res = await fetch('/api/csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dealerships.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
