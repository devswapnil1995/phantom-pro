const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('./'));
const PORT = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════════
// CREDENTIALS — stored server-side in creds.json
// Supports two auth methods:
//   A) API key + secret  → OAuth flow (12-month key, browser-based login once)
//   B) Manual token paste → stored + auto-renewed via /v2/RenewToken
// All Dhan API calls use server-stored credentials; frontend never needs to
// send the token with each request.
// ════════════════════════════════════════════════════════════

const CREDS_FILE = path.join(__dirname, 'creds.json');
let creds = { clientId: '', apiKey: '', apiSecret: '', accessToken: '', expiresAt: '' };

function loadCreds() {
  if (!fs.existsSync(CREDS_FILE)) return;
  try {
    Object.assign(creds, JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')));
    console.log('Credentials loaded — clientId:', creds.clientId, '| token expires:', creds.expiresAt || 'unknown');
  } catch (e) { console.warn('Could not load creds.json:', e.message); }
}

function saveCreds() {
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
}

loadCreds();

function isAuthenticated() {
  return !!(creds.accessToken && creds.clientId);
}

function getDhanHeaders() {
  return {
    'Content-Type': 'application/json',
    'access-token': creds.accessToken,
    'client-id':    creds.clientId,
  };
}

// Auto-renew token every 23 hours via Dhan's RenewToken endpoint
async function renewToken() {
  if (!isAuthenticated()) return;
  try {
    const r = await axios.get('https://api.dhan.co/v2/RenewToken', {
      headers: { 'access-token': creds.accessToken, 'dhanClientId': creds.clientId },
      timeout: 10000,
    });
    if (r.data && r.data.accessToken) {
      creds.accessToken = r.data.accessToken;
      creds.expiresAt   = r.data.expiryTime || '';
      saveCreds();
      console.log('Token auto-renewed. Expires:', creds.expiresAt);
    }
  } catch (e) {
    console.warn('Token renewal failed:', e.response && e.response.data ? e.response.data.errorMessage : e.message);
  }
}
setInterval(renewToken, 23 * 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════
// SCRIP MASTER
// Loads api-scrip-master-detailed.csv at boot.
// Index key = col[6] UNDERLYING_SYMBOL (e.g. RELIANCE, NIFTY, HDFCBANK)
//
// CSV columns used:
//   col[0]  EXCH_ID           NSE / BSE
//   col[1]  SEGMENT           E=equity  I=index  D=F&O  C=currency
//   col[2]  SECURITY_ID       <-- Dhan "securityId"
//   col[4]  INSTRUMENT        EQUITY / INDEX / FUTSTK ...
//   col[6]  UNDERLYING_SYMBOL <-- our lookup key
//   col[10] SERIES            EQ / BE / SM ... (keep only EQ for equities)
//
// ONLY two hardcoded defaults; everything else comes from CSV:
//   NIFTY50  -> index  id:13   IDX_I
//   HDFCBANK -> equity id:1333 NSE_EQ
// ════════════════════════════════════════════════════════════

const DEFAULTS = {
  'NIFTY50':   { securityId: '13',   exchangeSegment: 'IDX_I',  instrument: 'INDEX'  },
  'NIFTY':     { securityId: '13',   exchangeSegment: 'IDX_I',  instrument: 'INDEX'  },
  'BANKNIFTY': { securityId: '25',   exchangeSegment: 'IDX_I',  instrument: 'INDEX'  },
  'FINNIFTY':  { securityId: '27',   exchangeSegment: 'IDX_I',  instrument: 'INDEX'  },
  'MIDCPNIFTY':{ securityId: '442',  exchangeSegment: 'IDX_I',  instrument: 'INDEX'  },
  'SENSEX':    { securityId: '1',    exchangeSegment: 'BSE_IDX', instrument: 'INDEX'  },
  'HDFCBANK':  { securityId: '1333', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
};

const scripMap = {};   // SYMBOL -> { securityId, exchangeSegment, instrument }

function loadScripMaster() {
  const csvPath = path.join(__dirname, 'api-scrip-master-detailed.csv');
  if (!fs.existsSync(csvPath)) {
    console.warn('WARNING: api-scrip-master-detailed.csv not found — using defaults only');
    return;
  }

  // Map CSV segment codes to Dhan API values
  const SEG_MAP = {
    'NSE|E': { exchangeSegment: 'NSE_EQ',  instrument: 'EQUITY' },
    'NSE|I': { exchangeSegment: 'IDX_I',   instrument: 'INDEX'  },
    'BSE|E': { exchangeSegment: 'BSE_EQ',  instrument: 'EQUITY' },
    'BSE|I': { exchangeSegment: 'BSE_IDX', instrument: 'INDEX'  },
    // Skip NSE|D (F&O), BSE|D, NSE|C (currency) etc.
  };

  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  let loaded = 0;

  for (let i = 1; i < lines.length; i++) {
    const col = lines[i].trim().split(',');
    if (col.length < 11) continue;

    const exchId  = col[0];                         // NSE / BSE
    const segment = col[1];                         // E / I / D / C
    const secId   = col[2];                         // security ID number (string)
    const inst    = col[4];                         // EQUITY / INDEX / FUTSTK ...
    const symbol  = col[6].trim().toUpperCase();    // UNDERLYING_SYMBOL -> our key
    const series  = col[10].trim();                 // EQ / BE / SM ...

    if (!symbol || !secId) continue;

    const seg = SEG_MAP[exchId + '|' + segment];
    if (!seg) continue;   // skip F&O, currency, unsupported exchanges

    // For equities: only EQ series avoids duplicate BE/SM/N1 entries
    if (segment === 'E' && inst === 'EQUITY' && series !== 'EQ') continue;

    // First match wins (CSV ordering puts EQ before other series)
    if (!scripMap[symbol]) {
      scripMap[symbol] = {
        securityId:      secId,
        exchangeSegment: seg.exchangeSegment,
        instrument:      seg.instrument,
      };
      loaded++;
    }
  }

  console.log('Scrip master loaded: ' + loaded + ' symbols');
}

loadScripMaster();

// Resolve symbol -> Dhan API params
// Priority: CSV -> DEFAULTS -> warn and guess NSE_EQ
function getExchangeInfo(symbol) {
  const s = symbol.toUpperCase().trim();
  if (scripMap[s])  return scripMap[s];
  if (DEFAULTS[s])  return DEFAULTS[s];
  console.warn('Unknown symbol "' + s + '" — defaulting to NSE_EQ EQUITY');
  return { securityId: s, exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' };
}

// ════════════════════════════════════════════════════════════
// RATE LIMITER
// Dhan enforces ~1 request/second per user.
// ════════════════════════════════════════════════════════════
// Two independent queues:
//   enqueue()    — bar fetches and other Dhan calls
//   ltpEnqueue() — LTP/OHLC market-quote calls only
//
// ltpEnqueue uses a proper minimum-interval enforcer:
// it tracks lastLtpCallAt and always waits until 1100ms
// has elapsed since the last call, regardless of queue depth.
// This prevents 429s even when the queue drains between polls.
// ════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── General queue (bar fetches etc.)
const queue = [];
let   qRunning = false;

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (!qRunning) drainQueue();
  });
}

async function drainQueue() {
  qRunning = true;
  while (queue.length) {
    const { fn, resolve, reject } = queue.shift();
    try   { resolve(await fn()); }
    catch (e) { reject(e); }
    if (queue.length) await sleep(1100);
  }
  qRunning = false;
}

// ── Dedicated LTP queue — strictly 1 request per second
const ltpQueue = [];
let   ltpRunning  = false;
let   lastLtpCall = 0;          // timestamp of last fired LTP request

function ltpEnqueue(fn) {
  return new Promise((resolve, reject) => {
    ltpQueue.push({ fn, resolve, reject });
    if (!ltpRunning) drainLtpQueue();
  });
}

async function drainLtpQueue() {
  ltpRunning = true;
  while (ltpQueue.length) {
    // Always honour the 1100ms minimum gap from the last call
    const wait = 1100 - (Date.now() - lastLtpCall);
    if (wait > 0) await sleep(wait);

    const { fn, resolve, reject } = ltpQueue.shift();
    lastLtpCall = Date.now();
    try   { resolve(await fn()); }
    catch (e) { reject(e); }
  }
  ltpRunning = false;
}

// Axios POST with 429 auto-retry
async function dhanPost(url, body, headers) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await axios.post(url, body, { headers, timeout: 12000 });
    } catch (err) {
      if (err.response?.status === 429 && attempt < 3) {
        console.warn('  [429] rate limited — retry ' + attempt + '/3');
        await sleep(attempt * 2000);
        continue;
      }
      throw err;
    }
  }
}

// ════════════════════════════════════════════════════════════
// SIMULATION — fallback when Dhan has no data
// ════════════════════════════════════════════════════════════

function genSimBars(symbol, n) {
  const BASE = {
    NIFTY50: 23850, HDFCBANK: 1680, RELIANCE: 2950, TCS: 3800,
    INFY: 1480, SBIN: 820, ICICIBANK: 1250, AXISBANK: 1150,
    BANKNIFTY: 51200, BAJFINANCE: 7200, KOTAKBANK: 1900,
  };
  let p = BASE[symbol.toUpperCase()] || (800 + Math.random() * 2000);
  const o = [], h = [], l = [], c = [], v = [];
  for (let i = 0; i < (n || 100); i++) {
    const drift = (Math.floor(i / 25) % 2 === 0) ? 0.0003 : -0.0002;
    const noise = (Math.random() - 0.5) * 0.004;
    const open  = p;
    p = p * (1 + drift + noise);
    const rng = p * (0.002 + Math.random() * 0.003);
    o.push(open);
    h.push(Math.max(open, p) + rng * Math.random());
    l.push(Math.min(open, p) - rng * Math.random());
    c.push(p);
    v.push(Math.floor(60000 + Math.random() * 120000));
  }
  return { o, h, l, c, v };
}

// ════════════════════════════════════════════════════════════
// CORE BAR FETCH
//
// DHAN INTRADAY  POST /v2/charts/intraday
//   Supported for: NSE equities only (NOT indices)
//   Params (all required):
//     securityId      string  — from CSV col[2]
//     exchangeSegment string  — NSE_EQ
//     instrument      string  — EQUITY
//     interval        integer — 1, 5, 15, 25, or 60
//     oi              bool    — false for equity
//     fromDate        string  — YYYY-MM-DD  (max 5 calendar days back)
//     toDate          string  — YYYY-MM-DD
//   DO NOT include: expiryCode (F&O only field, causes 400)
//
// DHAN HISTORICAL  POST /v2/charts/historical
//   Supported for: NSE/BSE equities AND indices
//   Returns: daily OHLCV candles
//   Params (all required):
//     securityId      string  — from CSV col[2]
//     exchangeSegment string  — NSE_EQ / IDX_I / BSE_EQ
//     instrument      string  — EQUITY / INDEX
//     expiryCode      integer — 0 for equity and index
//     oi              bool    — false
//     fromDate        string  — YYYY-MM-DD
//     toDate          string  — YYYY-MM-DD
//   DO NOT include: interval
//
// Both return: { open:[], high:[], low:[], close:[], volume:[], timestamp:[] }
// ════════════════════════════════════════════════════════════

const INTRADAY_INTERVAL = { '1m': 1, '5m': 5, '15m': 15, '25m': 25, '60m': 60 };

function daysAgoStr(n) {
  return new Date(Date.now() - n * 86400000).toISOString().split('T')[0];
}

async function fetchBars(symbol, interval) {
  const { securityId, exchangeSegment, instrument } = getExchangeInfo(symbol);
  const isIndex     = (instrument === 'INDEX');
  const intMin      = INTRADAY_INTERVAL[interval];   // undefined for non-intraday
  const useIntraday = !isIndex && !!intMin;           // indices have no intraday endpoint

  const headers = getDhanHeaders();

  console.log('[Dhan] ' + symbol + '  id:' + securityId + '  seg:' + exchangeSegment + '  inst:' + instrument);

  // Queued Dhan call — returns bars object or null (never throws)
  async function callDhan(url, body) {
    try {
      const r = await enqueue(() => dhanPost(url, body, headers));
      const d = r.data;
      if (Array.isArray(d && d.open) && d.open.length > 0) {
        return {
          o: d.open.map(Number),
          h: d.high.map(Number),
          l: d.low.map(Number),
          c: d.close.map(Number),
          v: d.volume.map(Number),
        };
      }
      console.warn('  [empty] ' + url.split('/').pop() + ' returned 0 bars for ' + symbol);
      return null;
    } catch (err) {
      const status = err.response?.status ?? '?';
      const code   = err.response?.data?.errorCode ?? '';
      const msg    = err.response?.data?.errorMessage || err.message;
      console.warn('  [' + status + '/' + code + '] ' + symbol + ': ' + msg);
      return null;   // any error -> treat as no data -> try next step
    }
  }

  let bars = null;
  let note = '';

  // ── Step 1: Intraday (NSE equities only, not indices)
  if (useIntraday) {
    bars = await callDhan('https://api.dhan.co/v2/charts/intraday', {
      securityId,
      exchangeSegment,
      instrument,
      interval:  intMin,           // integer number of minutes e.g. 5
      oi:        false,
      fromDate:  daysAgoStr(5),    // 5 calendar days is the safe max for all minute intervals
      toDate:    daysAgoStr(0),
    });
    if (bars) note = 'intraday ' + interval;
  }

  // ── Step 2: Historical daily (equity and index, intraday fallback)
  if (!bars) {
    bars = await callDhan('https://api.dhan.co/v2/charts/historical', {
      securityId,
      exchangeSegment,
      instrument,
      expiryCode: 0,               // 0 for equity and index (required field)
      oi:         false,
      fromDate:   daysAgoStr(365),
      toDate:     daysAgoStr(0),
    });
    if (bars) note = 'historical daily';
  }

  // ── Step 3: Simulation (last resort)
  if (!bars) {
    console.warn('  [sim] ' + symbol + ' — no data from Dhan, using simulation');
    return {
      bars:   genSimBars(symbol, 100),
      note:   'simulation',
      source: 'simulation',
    };
  }

  // Cache successful Dhan result
  console.log('  OK ' + bars.o.length + ' bars for ' + symbol + ' via ' + note);
  return { bars, note, source: 'dhan-live' };
}

// ════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════

// ── Auth: Save API key + secret (one-time setup, 12-month validity)
app.post('/api/auth/save', (req, res) => {
  const { clientId, apiKey, apiSecret } = req.body;
  if (!clientId || !apiKey || !apiSecret)
    return res.status(400).json({ success: false, msg: 'Need clientId, apiKey and apiSecret' });
  creds.clientId  = clientId;
  creds.apiKey    = apiKey;
  creds.apiSecret = apiSecret;
  saveCreds();
  res.json({ success: true, msg: 'Credentials saved. Click "Connect with Dhan" to authenticate.' });
});

// ── Auth: Save a manually-pasted access token (fallback method)
app.post('/api/auth/manual', (req, res) => {
  const { clientId, token } = req.body;
  if (!clientId || !token)
    return res.status(400).json({ success: false, msg: 'Need clientId and token' });
  creds.clientId    = clientId;
  creds.accessToken = token;
  creds.expiresAt   = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  saveCreds();
  res.json({ success: true, msg: 'Manual token saved. Auto-renewal will keep it active.' });
});

// ── Auth: Status
app.get('/api/auth/status', (req, res) => {
  res.json({
    connected:  isAuthenticated(),
    clientId:   creds.clientId,
    expiresAt:  creds.expiresAt,
    hasApiKey:  !!(creds.apiKey && creds.apiSecret),
  });
});

// ── Auth: Start OAuth flow — Step 1: generate consent
// Requires redirect URL https://phantom-pro-production.up.railway.app/auth/callback set in Dhan Web
app.post('/api/auth/start', async (req, res) => {
  if (!creds.clientId || !creds.apiKey || !creds.apiSecret)
    return res.status(400).json({ success: false, msg: 'Save clientId, API key and secret first' });
  try {
    const r = await axios.post(
      'https://auth.dhan.co/app/generate-consent?client_id=' + creds.clientId,
      {},
      { headers: { 'app_id': creds.apiKey, 'app_secret': creds.apiSecret }, timeout: 10000 }
    );
    const consentAppId = r.data && r.data.consentAppId;
    if (!consentAppId)
      return res.status(500).json({ success: false, msg: 'No consentAppId in response', raw: r.data });
    const loginUrl = 'https://auth.dhan.co/login/consentApp-login?consentAppId=' + consentAppId;
    res.json({ success: true, loginUrl });
  } catch (err) {
    res.status(500).json({
      success: false,
      msg: err.response && err.response.data ? err.response.data.errorMessage : err.message,
    });
  }
});

// ── Auth: OAuth callback — Step 3: consume consent and store token
// Dhan redirects here: GET /auth/callback?tokenId=...
// Set redirect URL = https://phantom-pro-production.up.railway.app/auth/callback in Dhan Web API key settings
app.get('/auth/callback', async (req, res) => {
  const { tokenId } = req.query;
  if (!tokenId) return res.send('<h2>Error: tokenId missing from callback</h2>');
  try {
    const r = await axios.get(
      'https://auth.dhan.co/app/consumeApp-consent?tokenId=' + tokenId,
      { headers: { 'app_id': creds.apiKey, 'app_secret': creds.apiSecret }, timeout: 10000 }
    );
    const { accessToken, expiryTime, dhanClientId } = r.data;
    if (!accessToken)
      return res.send('<h2>Error: no accessToken in response</h2><pre>' + JSON.stringify(r.data, null, 2) + '</pre>');
    creds.accessToken = accessToken;
    creds.expiresAt   = expiryTime || '';
    if (dhanClientId) creds.clientId = dhanClientId;
    saveCreds();
    console.log('OAuth complete. Token stored for', creds.clientId, '— expires:', creds.expiresAt);
    res.redirect('/?connected=1');
  } catch (err) {
    res.send('<h2>OAuth error</h2><pre>' +
      (err.response && err.response.data ? JSON.stringify(err.response.data, null, 2) : err.message) +
      '</pre>');
  }
});

// ── Test API connection (uses stored token)
app.post('/api/test-dhan', async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ success: false, msg: 'Not authenticated — save credentials and connect first' });
  try {
    const r = await axios.post(
      'https://api.dhan.co/v2/marketfeed/ltp',
      { NSE_EQ: ['1333'] },   // HDFCBANK as test scrip
      { headers: getDhanHeaders(), timeout: 8000 }
    );
    res.json({ success: true, msg: 'Dhan API connected', clientId: creds.clientId, expiresAt: creds.expiresAt });
  } catch (err) {
    res.status(401).json({ success: false, msg: err.response && err.response.data ? err.response.data.errorMessage : err.message });
  }
});

// ── Fetch OHLCV bars for a symbol (uses stored token)
app.post('/api/dhan-bars', async (req, res) => {
  const { symbol, interval = '5m' } = req.body;
  if (!symbol)
    return res.status(400).json({ success: false, msg: 'Missing symbol' });
  if (!isAuthenticated())
    return res.status(401).json({ success: false, msg: 'Not authenticated', source: 'simulation' });

  const result = await fetchBars(symbol, interval);
  res.json({
    success: true,
    msg:     result.bars.o.length + ' bars (' + result.note + ')',
    bars:    result.bars,
    source:  result.source,
    note:    result.note,
  });
});

// ── Live LTP for multiple symbols (uses stored token)
app.post('/api/ltp', async (req, res) => {
  const { symbols } = req.body;
  if (!Array.isArray(symbols) || !symbols.length)
    return res.status(400).json({ success: false, msg: 'Need symbols[]' });
  if (!isAuthenticated())
    return res.status(401).json({ success: false, msg: 'Not authenticated' });

  // Split into equity (ltp endpoint) and index (ohlc endpoint)
  // Dhan docs: securityIds must be INTEGERS in the array, not strings
  const equityGroups = {};   // for /marketfeed/ltp
  const indexGroups  = {};   // for /marketfeed/ohlc
  const infoMap      = {};
  const unknown      = [];

  for (const sym of symbols) {
    const info = getExchangeInfo(sym);
    if (!/^\d+$/.test(info.securityId)) { unknown.push(sym); continue; }
    const id = parseInt(info.securityId, 10);
    infoMap[sym.toUpperCase()] = { ...info, numericId: id };
    if (info.instrument === 'INDEX') {
      if (!indexGroups[info.exchangeSegment]) indexGroups[info.exchangeSegment] = [];
      indexGroups[info.exchangeSegment].push(id);
    } else {
      if (!equityGroups[info.exchangeSegment]) equityGroups[info.exchangeSegment] = [];
      equityGroups[info.exchangeSegment].push(id);
    }
  }

  if (unknown.length) console.warn('[ltp] unknown symbols (not in CSV):', unknown.join(', '));

  const ltp = {};

  // Schedule BOTH calls through the dedicated LTP queue before awaiting either.
  // ltpEnqueue() tracks lastLtpCall timestamp and always enforces 1100ms between
  // Quote API calls — satisfying Dhan's strict 1 req/s limit for /marketfeed/*.
  const equityPromise = Object.keys(equityGroups).length
    ? ltpEnqueue(() => axios.post('https://api.dhan.co/v2/marketfeed/ltp',
        equityGroups, { headers: getDhanHeaders(), timeout: 8000 }))
    : null;

  const indexPromise = Object.keys(indexGroups).length
    ? ltpEnqueue(() => axios.post('https://api.dhan.co/v2/marketfeed/ohlc',
        indexGroups, { headers: getDhanHeaders(), timeout: 8000 }))
    : null;

  // ── Equities: parse /v2/marketfeed/ltp response
  if (equityPromise) {
    try {
      const r   = await equityPromise;
      const raw = (r.data && r.data.data) ? r.data.data : r.data;
      for (const [sym, info] of Object.entries(infoMap)) {
        if (info.instrument === 'INDEX') continue;
        const seg   = raw && raw[info.exchangeSegment];
        const entry = seg && (seg[info.securityId] || seg[info.numericId]);
        ltp[sym] = entry ? entry.last_price : null;
      }
      console.log('[ltp/equity] OK —', Object.values(equityGroups).flat().length, 'symbols');
    } catch (err) {
      const d = err.response && err.response.data;
      console.error('[ltp/equity] error', err.response && err.response.status, JSON.stringify(d));
    }
  }

  // ── Indices: parse /v2/marketfeed/ohlc response
  if (indexPromise) {
    try {
      const r   = await indexPromise;
      const raw = (r.data && r.data.data) ? r.data.data : r.data;
      for (const [sym, info] of Object.entries(infoMap)) {
        if (info.instrument !== 'INDEX') continue;
        const seg   = raw && raw[info.exchangeSegment];
        const entry = seg && (seg[info.securityId] || seg[info.numericId]);
        ltp[sym] = entry ? entry.last_price : null;
      }
      console.log('[ltp/index] OK —', Object.values(indexGroups).flat().length, 'symbols');
    } catch (err) {
      const d = err.response && err.response.data;
      console.error('[ltp/index] error', err.response && err.response.status, JSON.stringify(d));
      // Fallback: null — frontend keeps last known value
    }
  }

  res.json({ success: true, ltp });
});

// ── Test LTP for known equity + index to verify both endpoints
app.get('/api/test-ltp', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  const results = {};
  // Test equity: HDFCBANK (1333/NSE_EQ)
  // Route both through the dedicated LTP queue — same 1100ms enforcer as live poll
  const eqP  = ltpEnqueue(() => axios.post('https://api.dhan.co/v2/marketfeed/ltp',
    { NSE_EQ: [1333] }, { headers: getDhanHeaders(), timeout: 8000 }));
  const idxP = ltpEnqueue(() => axios.post('https://api.dhan.co/v2/marketfeed/ohlc',
    { IDX_I: [13]    }, { headers: getDhanHeaders(), timeout: 8000 }));

  try { const r = await eqP;  results.equity_ltp  = { status: r.status,               data: r.data }; }
  catch (e) {                  results.equity_ltp  = { status: e.response?.status,    error: e.response?.data }; }
  try { const r = await idxP; results.index_ohlc  = { status: r.status,               data: r.data }; }
  catch (e) {                  results.index_ohlc  = { status: e.response?.status,    error: e.response?.data }; }
  res.json(results);
});

// ── Symbol search from scrip master
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toUpperCase().trim();
  if (q.length < 2) return res.json([]);
  const results = Object.entries(scripMap)
    .filter(([sym]) => sym.startsWith(q))
    .slice(0, 20)
    .map(([symbol, info]) => ({ symbol, ...info }));
  res.json(results);
});

// ── Debug: inspect a symbol (uses stored token)
app.post('/api/debug-symbol', async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Need symbol' });
  if (!isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });

  const info   = getExchangeInfo(symbol.toUpperCase());
  const result = await fetchBars(symbol, '5m');
  res.json({
    symbol:       symbol.toUpperCase(),
    fromCSV:      !!scripMap[symbol.toUpperCase()],
    scripInfo:    info,
    barsReturned: result.bars.o.length,
    source:       result.source,
    note:         result.note,
    sample:       { open: result.bars.o.slice(0, 3), close: result.bars.c.slice(0, 3) },
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'phantom-pro-v2.html'));
});

app.listen(PORT, () => {
  console.log('PHANTOM PRO v2 running on http://localhost:' + PORT);
  if (isAuthenticated()) console.log('  Authenticated as', creds.clientId, '— expires:', creds.expiresAt);
  else console.log('  Not authenticated — open http://localhost:' + PORT + ' to connect');
});