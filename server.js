// Datasourcer — Express server.
//
// Routes:
//   GET  /                 -> static web UI (public/)
//   GET  /api/search       -> Server-Sent Events stream of pipeline progress
//   POST /api/csv          -> turn a results array into a downloadable CSV
//   GET  /api/health       -> basic status incl. whether Companies House is configured

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './src/pipeline.js';
import { toCsv } from './src/csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CH_API_KEY = process.env.CH_API_KEY || '';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    companiesHouseConfigured: Boolean(CH_API_KEY),
    time: new Date().toISOString(),
  });
});

// Streaming search via Server-Sent Events.
app.get('/api/search', async (req, res) => {
  const postcode = String(req.query.postcode || '').trim();
  const radius = clampInt(req.query.radius, 1, 200, 200);
  const maxPages = clampInt(req.query.maxPages, 1, 10, 1);
  const maxDealers = clampInt(req.query.maxDealers, 1, 200, 50);

  if (!postcode) {
    res.status(400).json({ error: 'postcode is required' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Keep the connection alive through long verifications.
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(keepAlive));

  try {
    send({ type: 'config', companiesHouseConfigured: Boolean(CH_API_KEY) });
    await runPipeline(
      { postcode, radius, maxPages, maxDealers, chApiKey: CH_API_KEY },
      send,
    );
  } catch (err) {
    send({ type: 'error', message: String(err && err.message ? err.message : err) });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

// CSV export.
app.post('/api/csv', (req, res) => {
  const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
  const csv = toCsv(records);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="dealerships.csv"');
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`Datasourcer running at http://localhost:${PORT}`);
  if (!CH_API_KEY) {
    console.log(
      'NOTE: CH_API_KEY not set — Companies House checks are disabled. ' +
        'Get a free key at https://developer.company-information.service.gov.uk/',
    );
  }
});

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
