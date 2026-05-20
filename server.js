const express  = require('express');
const http     = require('http');
const https    = require('https');
const WebSocket = require('ws');
const notifier = require('node-notifier');
const fs       = require('fs');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SYMBOLS     = ['VOO', 'VTI', 'QQQ'];
const ALERTS_FILE = path.join(__dirname, 'alerts.json');
const PORT        = 3000;
const INTERVAL_MS = 60_000;

// ── Direct Yahoo Finance HTTP helper ─────────────────────────────────────────
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};

function yfGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: YF_HEADERS }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── Fetch quotes (用 /v8/chart meta，不需 auth) ───────────────────────────────
async function fetchQuotes() {
  const out = {};
  for (const sym of SYMBOLS) {
    try {
      const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
      const data = await yfGet(url);
      const m    = data?.chart?.result?.[0]?.meta ?? {};
      const prev = m.chartPreviousClose ?? m.previousClose ?? 0;
      const price = m.regularMarketPrice ?? 0;
      const change = price - prev;
      const changePct = prev ? (change / prev) * 100 : 0;
      out[sym] = {
        symbol:    sym,
        name:      m.longName || m.shortName || sym,
        price,
        change,
        changePct,
        open:      m.regularMarketOpen      ?? prev,
        high:      m.regularMarketDayHigh   ?? price,
        low:       m.regularMarketDayLow    ?? price,
        prevClose: prev,
        volume:    m.regularMarketVolume    ?? 0,
        marketState: m.marketState          ?? 'CLOSED',
      };
    } catch (e) {
      console.error(`[${sym}] fetch error:`, e.message);
    }
  }
  return out;
}

// ── Fetch chart data ──────────────────────────────────────────────────────────
async function fetchChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=false`;
  const data = await yfGet(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('No chart data returned');

  const ts     = result.timestamp ?? [];
  const q      = result.indicators?.quote?.[0] ?? {};
  return ts.map((t, i) => ({
    t: t * 1000,
    o: q.open?.[i]  ?? null,
    h: q.high?.[i]  ?? null,
    l: q.low?.[i]   ?? null,
    c: q.close?.[i] ?? null,
    v: q.volume?.[i] ?? null,
  })).filter(d => d.c !== null);
}

// ── Alert persistence ─────────────────────────────────────────────────────────
function loadAlerts() {
  if (fs.existsSync(ALERTS_FILE)) {
    try { return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch {}
  }
  return {};
}
function saveAlerts(data) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2));
}

let alerts = loadAlerts();
const lastAlertFired = {};
const COOLDOWN = 5 * 60_000;

// ── Check & fire alerts ───────────────────────────────────────────────────────
function checkAlerts(quotes) {
  const triggered = [];
  for (const sym of SYMBOLS) {
    const q = quotes[sym];
    const a = alerts[sym];
    if (!q || !a) continue;
    const now = Date.now();

    const fire = (kind, price, target) => {
      const key = `${sym}_${kind}`;
      if (lastAlertFired[key] && now - lastAlertFired[key] < COOLDOWN) return;
      lastAlertFired[key] = now;
      const dir   = kind === 'high' ? '突破高點 🟢' : '跌破低點 🔴';
      const emoji = kind === 'high' ? '📈' : '📉';
      notifier.notify({
        title:   `${emoji} ${sym} 價格警報！`,
        message: `${dir}\n現價 $${price.toFixed(2)}  目標 $${target.toFixed(2)}`,
        sound:   true,
        wait:    false,
      });
      triggered.push({ symbol: sym, type: kind, price, target });
      console.log(`[ALERT] ${sym} ${kind}: ${price} vs ${target}`);
    };

    if (a.high && q.price >= parseFloat(a.high)) fire('high', q.price, parseFloat(a.high));
    if (a.low  && q.price <= parseFloat(a.low))  fire('low',  q.price, parseFloat(a.low));
  }
  return triggered;
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── Tick ──────────────────────────────────────────────────────────────────────
async function tick() {
  try {
    const quotes    = await fetchQuotes();
    const triggered = checkAlerts(quotes);
    broadcast({ type: 'update', quotes, triggered, alerts, ts: Date.now() });
    process.stdout.write(`[${new Date().toLocaleTimeString()}] updated: ${Object.keys(quotes).map(s => `${s}=$${quotes[s].price}`).join(' ')}\n`);
  } catch (e) {
    console.error('[tick]', e.message);
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/alerts', (_req, res) => res.json(alerts));

app.post('/api/alerts', (req, res) => {
  const { symbol, high, low } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  alerts[symbol] = {
    high: high !== '' && high != null ? parseFloat(high) : null,
    low:  low  !== '' && low  != null ? parseFloat(low)  : null,
  };
  saveAlerts(alerts);
  broadcast({ type: 'alerts', alerts });
  res.json({ ok: true, alerts });
});

app.get('/api/chart/:symbol/:period', async (req, res) => {
  const { symbol, period } = req.params;
  const rangeMap    = { '1d':'1d',  '5d':'5d',  '1mo':'3mo', '3mo':'3mo' };
  const intervalMap = { '1d':'5m',  '5d':'15m', '1mo':'1d',  '3mo':'1d'  };
  // 3mo 用 Yahoo 的 range=3mo，1mo 也用 3mo range 取近 1 個月的點
  const range    = rangeMap[period]    ?? '1d';
  const interval = intervalMap[period] ?? '5m';
  try {
    let data = await fetchChart(symbol, range, interval);
    // 1mo 只取最近 30 天
    if (period === '1mo') {
      const cutoff = Date.now() - 30 * 86400_000;
      data = data.filter(d => d.t >= cutoff);
    }
    res.json(data);
  } catch (e) {
    console.error(`[chart] ${symbol}/${period}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', async (ws) => {
  console.log('[WS] client connected');
  try {
    const quotes = await fetchQuotes();
    ws.send(JSON.stringify({ type: 'update', quotes, triggered: [], alerts, ts: Date.now() }));
  } catch (e) {
    console.error('[WS init]', e.message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Stock Tracker → http://localhost:${PORT}\n`);
  tick();
  setInterval(tick, INTERVAL_MS);
});
