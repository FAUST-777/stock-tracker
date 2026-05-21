const express  = require('express');
const http     = require('http');
const https    = require('https');
const WebSocket = require('ws');
const notifier = require('node-notifier');
const cron     = require('node-cron');
const fs       = require('fs');
const path     = require('path');

// ── LINE Bot config ───────────────────────────────────────────────────────────
const cfg = fs.existsSync('./config.json')
  ? JSON.parse(fs.readFileSync('./config.json', 'utf8'))
  : {};
const LINE_TOKEN  = cfg.line?.channelAccessToken ?? '';
const LINE_USERID = cfg.line?.userId ?? '';

function sendLine(text) {
  if (!LINE_TOKEN || !LINE_USERID) return;
  const body = JSON.stringify({
    to: LINE_USERID,
    messages: [{ type: 'text', text }],
  });
  const req = https.request({
    hostname: 'api.line.me',
    path:     '/v2/bot/message/push',
    method:   'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Length': Buffer.byteLength(body),
    },
  }, (res) => {
    if (res.statusCode !== 200) {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => console.error('[LINE]', res.statusCode, d));
    }
  });
  req.on('error', e => console.error('[LINE] request error:', e.message));
  req.write(body);
  req.end();
}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const US_SYMBOLS  = ['VOO', 'VTI', 'QQQ'];
const TW_SYMBOLS  = ['2330.TW', '0050.TW'];
const SYMBOLS     = [...US_SYMBOLS, ...TW_SYMBOLS];
const ALERTS_FILE = path.join(__dirname, 'alerts.json');
const PORT        = 3000;
const INTERVAL_MS = 60_000;

// 幣別判斷
const currency = sym => sym.endsWith('.TW') ? 'NT$' : '$';

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
        currency:  currency(sym),
        isTW:      sym.endsWith('.TW'),
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
      // LINE 推播
      const lineMsg = [
        `${emoji} ${sym} 價格警報！`,
        `────────────────`,
        `${dir}`,
        `現價：$${price.toFixed(2)}`,
        `目標：$${target.toFixed(2)}`,
        `時間：${new Date().toLocaleTimeString('zh-TW')}`,
      ].join('\n');
      sendLine(lineMsg);
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
  const rangeMap    = { '1d':'1d', '5d':'5d', '1mo':'3mo', '3mo':'3mo', '6mo':'6mo', '1y':'1y' };
  const intervalMap = { '1d':'5m', '5d':'15m', '1mo':'1d', '3mo':'1d',  '6mo':'1d',  '1y':'1wk' };
  const cutoffDays  = { '1mo': 30 };
  const range    = rangeMap[period]    ?? '1d';
  const interval = intervalMap[period] ?? '5m';
  try {
    let data = await fetchChart(symbol, range, interval);
    if (cutoffDays[period]) {
      const cutoff = Date.now() - cutoffDays[period] * 86400_000;
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

// 測試端點：立即觸發日報
app.get('/api/report/test', async (_req, res) => {
  await sendDailyReport();
  res.json({ ok: true, message: '日報已發送至 LINE' });
});

// ── 每日開盤前報告 ─────────────────────────────────────────────────────────────
// 抓大盤指數（S&P500 / NASDAQ / 道瓊 / VIX）
async function fetchIndices() {
  const indices = [
    { sym: '^GSPC', label: 'S&P 500' },
    { sym: '^IXIC', label: 'NASDAQ' },
    { sym: '^DJI',  label: '道瓊 DJI' },
    { sym: '^VIX',  label: 'VIX 恐慌' },
  ];
  const results = [];
  for (const idx of indices) {
    try {
      const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(idx.sym)}?interval=1d&range=1d`;
      const data = await yfGet(url);
      const m    = data?.chart?.result?.[0]?.meta ?? {};
      const prev = m.chartPreviousClose ?? m.previousClose ?? 0;
      const price = m.regularMarketPrice ?? 0;
      const chgPct = prev ? ((price - prev) / prev * 100) : 0;
      results.push({ label: idx.label, price, chgPct });
    } catch {}
  }
  return results;
}

async function sendDailyReport() {
  try {
    // 抓最新報價 + 大盤指數（平行）
    const [freshQuotes, indices] = await Promise.all([fetchQuotes(), fetchIndices()]);
    const lines = [
      '📊 美股開盤前日報',
      `🕘 ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`,
      '─────────────────',
    ];

    // 大盤指數區塊
    if (indices.length) {
      lines.push('🌐 大盤指數');
      for (const idx of indices) {
        const arrow = idx.chgPct >= 0 ? '▲' : '▼';
        const cls   = idx.chgPct >= 0 ? '+' : '';
        const vixNote = idx.label.includes('VIX')
          ? (idx.price >= 30 ? ' ⚠️高波動' : idx.price >= 20 ? ' 😐中波動' : ' 😌低波動')
          : '';
        lines.push(`  ${idx.label.padEnd(10)} ${idx.price.toFixed(2)}  ${arrow}${cls}${Math.abs(idx.chgPct).toFixed(2)}%${vixNote}`);
      }
      lines.push('─────────────────');
    }

    for (const sym of SYMBOLS) {
      const q = freshQuotes[sym];
      const a = alerts[sym] || {};
      if (!q) continue;

      // 近一週走勢（5d 日線）
      let weekTrend = '';
      try {
        const chart5d = await fetchChart(sym, '5d', '1d');
        if (chart5d.length >= 2) {
          const oldest = chart5d[0].c;
          const latest = chart5d[chart5d.length - 1].c;
          const pct = ((latest - oldest) / oldest * 100).toFixed(2);
          weekTrend = pct >= 0 ? `📈 近5日 +${pct}%` : `📉 近5日 ${pct}%`;
        }
      } catch {}

      lines.push(`\n▌ ${sym}   $${q.price.toFixed(2)}`);
      if (weekTrend) lines.push(weekTrend);

      // 距高點警報
      if (a.high) {
        const diff = ((parseFloat(a.high) - q.price) / q.price * 100);
        const abs  = Math.abs(diff).toFixed(2);
        if (diff > 0) {
          const icon = diff <= 2 ? '🔴' : diff <= 5 ? '🟡' : '🟢';
          lines.push(`${icon} 距高點警報 還差 +${abs}%  (目標 $${parseFloat(a.high).toFixed(2)})`);
        } else {
          lines.push(`🚨 已超過高點警報 +${abs}%  (目標 $${parseFloat(a.high).toFixed(2)})`);
        }
      }

      // 距低點警報
      if (a.low) {
        const diff = ((q.price - parseFloat(a.low)) / q.price * 100);
        const abs  = Math.abs(diff).toFixed(2);
        if (diff > 0) {
          const icon = diff <= 2 ? '🔴' : diff <= 5 ? '🟡' : '🟢';
          lines.push(`${icon} 距低點警報 還差 -${abs}%  (目標 $${parseFloat(a.low).toFixed(2)})`);
        } else {
          lines.push(`🚨 已跌破低點警報 -${abs}%  (目標 $${parseFloat(a.low).toFixed(2)})`);
        }
      }

      if (!a.high && !a.low) lines.push('⚪ 尚未設定警報');
    }

    // 台股區塊
    lines.push('\n🇹🇼 台股追蹤（當日收盤）');
    for (const sym of TW_SYMBOLS) {
      const q = freshQuotes[sym];
      const a = alerts[sym] || {};
      if (!q) continue;

      let weekTrend = '';
      try {
        const chart5d = await fetchChart(sym, '5d', '1d');
        if (chart5d.length >= 2) {
          const pct = ((chart5d[chart5d.length-1].c - chart5d[0].c) / chart5d[0].c * 100).toFixed(2);
          weekTrend = pct >= 0 ? `📈 近5日 +${pct}%` : `📉 近5日 ${pct}%`;
        }
      } catch {}

      const label = sym === '2330.TW' ? '台積電 2330' : '元大50 0050';
      lines.push(`\n▌ ${label}   NT$${q.price.toFixed(0)}`);
      if (weekTrend) lines.push(weekTrend);

      if (a.high) {
        const diff = ((parseFloat(a.high) - q.price) / q.price * 100);
        const abs  = Math.abs(diff).toFixed(2);
        const icon = Math.abs(diff) <= 2 ? '🔴' : Math.abs(diff) <= 5 ? '🟡' : '🟢';
        lines.push(diff > 0
          ? `${icon} 距高點警報 還差 +${abs}%  (目標 NT$${parseFloat(a.high).toFixed(0)})`
          : `🚨 已超過高點警報  (目標 NT$${parseFloat(a.high).toFixed(0)})`);
      }
      if (a.low) {
        const diff = ((q.price - parseFloat(a.low)) / q.price * 100);
        const abs  = Math.abs(diff).toFixed(2);
        const icon = Math.abs(diff) <= 2 ? '🔴' : Math.abs(diff) <= 5 ? '🟡' : '🟢';
        lines.push(diff > 0
          ? `${icon} 距低點警報 還差 -${abs}%  (目標 NT$${parseFloat(a.low).toFixed(0)})`
          : `🚨 已跌破低點警報  (目標 NT$${parseFloat(a.low).toFixed(0)})`);
      }
      if (!a.high && !a.low) lines.push('⚪ 尚未設定警報');
    }

    lines.push('\n─────────────────');
    lines.push('🇺🇸 美股即將開盤，祝交易順利！');
    sendLine(lines.join('\n'));
    console.log('[daily report] sent');
  } catch (e) {
    console.error('[daily report] error:', e.message);
  }
}

// 週一至週五 台灣時間 21:00（夏令，美股 9:30PM 開盤前 30 分鐘）
cron.schedule('0 21 * * 1-5', sendDailyReport, { timezone: 'Asia/Taipei' });
// 週一至週五 台灣時間 22:00（冬令，美股 10:30PM 開盤前 30 分鐘）
cron.schedule('0 22 * * 1-5', sendDailyReport, { timezone: 'Asia/Taipei' });

console.log('[cron] 每日開盤前報告已設定（夏令 21:00 / 冬令 22:00 台灣時間）');

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Stock Tracker → http://localhost:${PORT}\n`);
  tick();
  setInterval(tick, INTERVAL_MS);
});
