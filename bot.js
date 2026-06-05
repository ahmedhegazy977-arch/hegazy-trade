const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const watchlist = new Map();

// EGX Stocks Map
const STOCKS = {
  'EFID': 'EFID.CA', 'COMI': 'COMI.CA', 'ETEL': 'ETEL.CA',
  'SWDY': 'SWDY.CA', 'HRHO': 'HRHO.CA', 'ESRS': 'ESRS.CA',
  'PHDC': 'PHDC.CA', 'TMGH': 'TMGH.CA', 'EAST': 'EAST.CA',
  'EGBN': 'EGBN.CA', 'OCDI': 'OCDI.CA', 'ISPH': 'ISPH.CA',
  'MNHD': 'MNHD.CA', 'OBEL': 'OBEL.CA', 'SODIC': 'SODIC.CA'
};

// --- Technical Indicators ---
const calc = {
  sma: (data, period) => {
    if (data.length < period) return null;
    return data.slice(-period).reduce((a, b) => a + b, 0) / period;
  },
  ema: (data, period) => {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * k + ema;
    }
    return ema;
  },
  rsi: (closes, period = 14) => {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change; else losses -= change;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) {
        avgGain = (avgGain * (period - 1) + change) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) - change) / period;
      }
    }
    return avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  },
  macd: (closes) => {
    const ema12 = calc.ema(closes, 12);
    const ema26 = calc.ema(closes, 26);
    if (!ema12 || !ema26) return null;
    const line = ema12 - ema26;
    const vals = [];
    for (let i = 26; i < closes.length; i++) {
      const e12 = calc.ema(closes.slice(0, i + 1), 12);
      const e26 = calc.ema(closes.slice(0, i + 1), 26);
      if (e12 && e26) vals.push(e12 - e26);
    }
    const signal = calc.ema(vals, 9);
    return { line, signal, histogram: line - signal };
  }
};

// --- Data Fetching ---
async function fetchQuote(symbol) {
  const ticker = STOCKS[symbol.toUpperCase()];
  if (!ticker) return { error: 'Symbol not supported' };

  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?range=1y&interval=1d';
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000
    });

    const result = data.chart?.result?.[0];
    if (!result || !result.meta) return { error: 'No data' };

    const meta = result.meta;
    const quotes = result.indicators?.quote?.[0];
    const closes = quotes?.close?.filter(v => v !== null) || [];
    const volumes = quotes?.volume?.filter(v => v !== null) || [];
    const opens = quotes?.open?.filter(v => v !== null) || [];

    const price = meta.regularMarketPrice || closes[closes.length - 1];
    const prev = meta.previousClose || closes[closes.length - 2] || price;

    return {
      ok: true,
      data: {
        symbol: symbol.toUpperCase(),
        price,
        change: price - prev,
        changePercent: ((price - prev) / prev) * 100,
        currency: meta.currency || 'EGP',
        volume: meta.regularMarketVolume || volumes[volumes.length - 1] || 0,
        closes, volumes, opens
      }
    };
  } catch (e) {
    return { error: 'API Error: ' + e.message };
  }
}

// --- Advanced Filter Logic ---
function runFilter(data) {
  const { closes, volumes, price, volume } = data;
  if (closes.length < 200) return { passed: false, reason: 'Need more data' };

  const checks = {};
  const smaV = calc.sma(volumes, 20);
  checks.vol = smaV && volume >= smaV * 1.2;
  
  const lastOpen = data.opens[data.opens.length - 1];
  const stab = lastOpen ? Math.abs(price - lastOpen) / price : 1;
  checks.stab = stab < 0.02;
  
  const e50 = calc.ema(closes, 50), e200 = calc.ema(closes, 200);
  checks.trend = e50 && e200 && price > e50 && price > e200;
  
  const rsi = calc.rsi(closes);
  checks.rsi = rsi && rsi >= 48 && rsi <= 55;
  
  const macd = calc.macd(closes);
  checks.macd = macd && Math.abs(macd.histogram) < 0.1;

  const passed = Object.values(checks).every(v => v);
  const score = Object.values(checks).filter(v => v).length;

  return { passed, score, total: 5, details: {
    vol: { pass: checks.vol, val: volume, thr: smaV ? Math.round(smaV*1.2) : null },
    stab: { pass: checks.stab, val: (stab*100).toFixed(2)+'%' },
    trend: { pass: checks.trend, e50: e50?.toFixed(1), e200: e200?.toFixed(1) },
    rsi: { pass: checks.rsi, val: rsi?.toFixed(1) },
    macd: { pass: checks.macd, val: macd?.histogram?.toFixed(3) }
  }};
}

// --- Commands ---

// 1. Start
bot.onText(/^\/start$/i, (msg) => {
  let txt = 'Hegazy Trade Bot v3.0 (Clean)\n\n';
  txt += 'Commands:\n';
  txt += '/price SYMBOL - Live Price\n';
  txt += '/filter SYMBOL - Advanced Technical Filter\n';
  txt += '/scan - Scan Market for Opportunities\n';
  txt += '/add SYMBOL - Add to Watchlist\n';
  txt += '/list - View Watchlist\n\n';
  txt += 'Example: /filter EFID';
  bot.sendMessage(msg.chat.id, txt);
});

// 2. Price
bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, 'Loading ' + sym + '...');
  const res = await fetchQuote(sym);
  
  if (res.error) return bot.editMessageText('Error: ' + res.error, { chat_id: msg.chat.id, message_id: load.message_id });
  
  const d = res.data;
  const icon = d.change >= 0 ? '📈' : '📉';
  let txt = d.symbol + '\n';
  txt += 'Price: ' + d.price.toFixed(2) + ' ' + d.currency + '\n';
  txt += icon + ' Change: ' + d.change.toFixed(2) + ' (' + d.changePercent.toFixed(2) + '%)\n';
  txt += 'Vol: ' + d.volume.toLocaleString();
  
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
});

// 3. Filter (The Main Feature)
bot.onText(/^\/filter\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, 'Analyzing ' + sym + '...');
  const res = await fetchQuote(sym);
  
  if (res.error) return bot.editMessageText('Error: ' + res.error, { chat_id: msg.chat.id, message_id: load.message_id });
  
  const f = runFilter(res.data);
  const dt = f.details;
  
  let txt = 'FILTER: ' + sym + '\n';
  txt += 'Price: ' + res.data.price.toFixed(2) + '\n\n';
  txt += (dt.vol.pass ? '✅' : '❌') + ' Volume: ' + dt.vol.val + (dt.vol.thr ? ' (Need: ' + dt.vol.thr + ')' : '') + '\n';
  txt += (dt.stab.pass ? '✅' : '❌') + ' Stability: ' + dt.stab.val + ' (<2%)\n';
  txt += (dt.trend.pass ? '✅' : '❌') + ' Trend: > EMA50(' + dt.trend.e50 + ') & EMA200(' + dt.trend.e200 + ')\n';
  txt += (dt.rsi.pass ? '✅' : '❌') + ' RSI: ' + dt.rsi.val + ' (48-55)\n';
  txt += (dt.macd.pass ? '✅' : '❌') + ' MACD: ' + dt.macd.val + ' (~0)\n\n';
  txt += 'Score: ' + f.score + '/5\n';
  
  if (f.passed) txt += '\n*** PERFECT BUY SIGNAL ***';
  else if (f.score >= 4) txt += '\n* Strong Candidate *';
  
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
});

// 4. Scan Market
bot.onText(/^\/scan$/i, async (msg) => {
  const load = await bot.sendMessage(msg.chat.id, 'Scanning market... (wait 30s)');
  let buys = [], watch = [];
  
  for (const sym of Object.keys(STOCKS)) {
    const res = await fetchQuote(sym);
    if (res.ok) {
      const f = runFilter(res.data);
      if (f.passed) buys.push(sym + '(' + res.data.price.toFixed(2) + ')');
      else if (f.score >= 4) watch.push(sym + '(' + f.score + '/5)');
    }
  }
  
  let txt = 'MARKET SCAN\n\n';
  txt += 'BUY SIGNALS (' + buys.length + '):\n' + (buys.join(', ') || 'None') + '\n\n';
  txt += 'WATCH LIST (' + watch.length + '):\n' + (watch.join(', ') || 'None');
  
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
});

// 5. Watchlist
bot.onText(/^\/add\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not found');
  if (!watchlist.has(msg.chat.id)) watchlist.set(msg.chat.id, []);
  const list = watchlist.get(msg.chat.id);
  if (!list.includes(sym)) {
    list.push(sym);
    bot.sendMessage(msg.chat.id, 'Added ' + sym);
  } else {
    bot.sendMessage(msg.chat.id, 'Already exists');
  }
});

bot.onText(/^\/list$/i, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  bot.sendMessage(msg.chat.id, list.length ? 'Watchlist:\n' + list.join('\n') : 'Empty');
});

console.log('Bot Started - Clean Syntax v3.0');