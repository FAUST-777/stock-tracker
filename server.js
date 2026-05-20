const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const yahoo   = require('yahoo-finance2').default;
const notifier = require('node-notifier');
const fs      = require('fs');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SYMBOLS    = ['VOO', 'VTI', 'QQQ'];
const ALERTS_FILE = path.join(__dirname, 'alerts.json');
const PORT       = 3000;
const INTERVAL_MS = 60_000; // 每 60 秒更新

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
const lastAlertFired = {}; // symbol_high / symbol_low → timestamp
const COOLDOWN = 5 * 60_000; // 同一警報 5 分鐘只響一次

// ── Fetch quotes ──────────────────────────────────────────────────────────────
async function fetchQuotes() {
  const out = {};
  for (const sym of SYMBOLS) {
    try {
      const q = await yahoo.quote(sym, {}, { validateResult: false });
      out[sym] = {
        symbol:        sym,
        name:          q.longName || q.shortName || sym,
        price:         q.regularMarketPrice      ?? 0,
        change:        q.regularMarketChange     ?? 0,
        changePct:     q.regularMarketChangePercent ?? 0,
        open:          q.regularMarketOpen       ?? 0,
        high:          q.regularMarketDayHigh    ?? 0,
        low:           q.regularMarketDayLow     ?? 0,
        prevClose:     q.regularMarketPreviousClose ?? 0,
        volume:        q.regularMarketVolume     ?? 0,
        marketState:   q.marketState             ?? 'CLOSED',
      };
    } catch (e) {
      console.error(`[${sym}] fetch error:`, e.message);
    }
  }
  return out;
}

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
        appID:   'Stock Tracker',
      });
      triggered.push({ symbol: sym, type: kind, price, target });
      console.log(`[ALERT] ${sym} ${kind}: ${price} vs ${target}`);
    };

    if (a.high && q.price >= parseFloat(a.high)) fire('high', q.price, parseFloat(a.high));
    if (a.low  && q.price <= parseFloat(a.low))  fire('low',  q.price, parseFloat(a.low));
  }
  return triggered;
}

// ── Broadcast to all WS clients ───────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── Main update loop ──────────────────────────────────────────────────────────
async function tick() {
  try {
    const quotes    = await fetchQuotes();
    const triggered = checkAlerts(quotes);
    broadcast({ type: 'update', quotes, triggered, alerts, ts: Date.now() });
    process.stdout.write(`[${new Date().toLocaleTimeString()}] prices updated\n`);
  } catch (e) {
    console.error('tick error:', e.message);
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
  const map = {
    '1d':  { period1: new Date(Date.now() - 1  * 86400_000), interval: '5m'  },
    '5d':  { period1: new Date(Date.now() - 5  * 86400_000), interval: '15m' },
    '1mo': { period1: new Date(Date.now() - 30 * 86400_000), interval: '1d'  },
    '3mo': { period1: new Date(Date.now() - 90 * 86400_000), interval: '1d'  },
  };
  const cfg = map[period] ?? map['1d'];
  try {
    const r = await yahoo.chart(symbol, { period1: cfg.period1, interval: cfg.interval }, { validateResult: false });
    const data = (r.quotes ?? []).filter(q => q.close != null).map(q => ({
      t: new Date(q.date).getTime(),
      o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume,
    }));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', async (ws) => {
  console.log('[WS] client connected');
  const quotes = await fetchQuotes();
  ws.send(JSON.stringify({ type: 'update', quotes, triggered: [], alerts, ts: Date.now() }));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Stock Tracker → http://localhost:${PORT}\n`);
  tick();
  setInterval(tick, INTERVAL_MS);
});
