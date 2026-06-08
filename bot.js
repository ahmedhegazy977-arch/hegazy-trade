const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

function getCached(sym) {
  const item = cache.get(sym);
  return (item && Date.now() - item.time < CACHE_TTL) ? item.data : null;
}
function setCache(sym, data) { cache.set(sym, { data, time: Date.now() }); }

const STOCKS = {
  'COMI':'COMI','EGBN':'EGBN','ABUK':'ABUK','ALEX':'ALEX','CAIB':'CAIB',
  'CIHB':'CIHB','EBNK':'EBNK','EKBN':'EKBN','NSGB':'NSGB','SAIB':'SAIB',
  'PHDC':'PHDC','TMGH':'TMGH','SODIC':'SODIC','MNHD':'MNHD','OBEL':'OBEL',
  'OCDI':'OCDI','FWRY':'FWRY','EKHO':'EKHO','EKZN':'EKZN','HELI':'HELI',
  'LXIN':'LXIN','MOPH':'MOPH','NILE':'NILE','QALY':'QALY','PALM':'PALM',
  'EFID':'EFID','EAST':'EAST','ORWE':'ORWE','JUFO':'JUFO','ZMZA':'ZMZA',
  'KARO':'KARO','HOD':'HOD','DOMT':'DOMT','PHCI':'PHCI','RMDA':'RMDA',
  'ISPH':'ISPH','UNIP':'UNIP','MKPH':'MKPH','EIPIC':'EIPIC','ETEL':'ETEL',
  'TELS':'TELS','ITPAC':'ITPAC','SWDY':'SWDY','HRHO':'HRHO','ESRS':'ESRS',
  'MCDR':'MCDR','SKPC':'SKPC','APPC':'APPC','OLFI':'OLFI','TALM':'TALM',
  'UPFD':'UPFD','WUFA':'WUFA','YRGN':'YRGN','ZOD':'ZOD','INEG':'INEG',
  'LUTS':'LUTS','AGRI':'AGRI','CEMI':'CEMI','CHEM':'CHEM','CLHO':'CLHO',
  'EGAS':'EGAS','ETRA':'ETRA','FERT':'FERT','GAS':'GAS','GLBC':'GLBC',
  'IRON':'IRON','MINA':'MINA','MNQC':'MNQC','PACK':'PACK','PAPR':'PAPR',
  'PLAS':'PLAS','POLY':'POLY','RUBR':'RUBR','SAND':'SAND','SHMD':'SHMD',
  'STLT':'STLT','TEXT':'TEXT','TILE':'TILE','TIMB':'TIMB','AUTO':'AUTO',
  'SPIN':'SPIN','EGTS':'EGTS','THMD':'THMD','ALHE':'ALHE','HOTL':'HOTL',
  'TOUR':'TOUR','TRVL':'TRVL','ELEC':'ELEC','ENER':'ENER','FINS':'FINS',
  'HOLD':'HOLD','INVS':'INVS','LEAS':'LEAS','REIT':'REIT','SUKN':'SUKN'
};

const tvLink = (sym) => `https://www.tradingview.com/chart/?symbol=EGX:${sym}`;

// ==================== Mubasher Scraper (3-Layer Fallback) ====================
async function fetchMubasher(symbol) {
  const cached = getCached(symbol);
  if (cached) return { ok: true, data: cached };

  try {
    const url = `https://www.mubasher.info/markets/EGX/stocks/${symbol}/`;
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Referer': 'https://www.mubasher.info/'
      },
      timeout: 15000
    });

    const $ = cheerio.load(html);
    let price, change, changePct;

    // Layer 1: Open Graph Meta Tags
    price = parseFloat($('meta[property="og:price:amount"]').attr('content'));
    change = parseFloat($('meta[property="og:price:change"]').attr('content'));
    changePct = parseFloat(($('meta[property="og:price:change_percent"]').attr('content') || '').replace('%', ''));

    // Layer 2: Embedded JSON/Data Attributes
    if (isNaN(price)) {
      const jsonMatch = html.match(/"price":\s*([\d.]+)/);
      if (jsonMatch) price = parseFloat(jsonMatch[1]);
      const chMatch = html.match(/"change":\s*(-?[\d.]+)/);
      if (chMatch) change = parseFloat(chMatch[1]);
    }

    // Layer 3: Regex Fallback on visible text
    if (isNaN(price)) {
      const textMatch = html.match(/([\d,]+\.\d{2})\s*(جنيه|EGP)/);
      if (textMatch) price = parseFloat(textMatch[1].replace(',', ''));
    }

    if (isNaN(price)) throw new Error('Price not found');

    const volumeText = $('[data-testid="volume"] .value, .market-stats__item:contains("حجم التداول") .value').first().text();
    const volume = parseInt((volumeText || '0').replace(/[^0-9]/g, ''));

    const high = parseFloat($('.market-stats__item:contains("أعلى") .value').text().replace(/,/g, '')) || 0;
    const low = parseFloat($('.market-stats__item:contains("أدنى") .value').text().replace(/,/g, '')) || 0;
    const open = parseFloat($('.market-stats__item:contains("افتتاح") .value').text().replace(/,/g, '')) || 0;
    const prevClose = parseFloat($('.market-stats__item:contains("إغلاق سابق") .value').text().replace(/,/g, '')) || (price - (change || 0));

    const obj = {
      symbol: symbol.toUpperCase(),
      price, change: change || 0, changePercent: changePct || 0, volume: volume || 0,
      high, low, open, prevClose, currency: 'EGP', source: 'Mubasher.info'
    };
    setCache(symbol, obj);
    return { ok: true, data: obj };
  } catch (e) {
    console.warn(`Mubasher failed for ${symbol}, falling back to Yahoo...`);
    return await fetchYahooFallback(symbol);
  }
}

// ==================== Yahoo Fallback (للمحافظة على عمل البوت) ====================
async function fetchYahooFallback(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.CA?range=1d&interval=1m`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const m = data.chart?.result?.[0]?.meta;
    if (!m || !m.regularMarketPrice) throw new Error('No data');
    const price = m.regularMarketPrice;
    const prev = m.previousClose || price;
    return {
      ok: true,
      data: {
        symbol: symbol.toUpperCase(), price,
        change: price - prev, changePercent: ((price - prev) / prev) * 100,
        volume: m.regularMarketVolume || 0,
        high: m.regularMarketDayHigh || price, low: m.regularMarketDayLow || price,
        open: m.regularMarketDayOpen || price, prevClose: prev,
        currency: 'EGP', source: 'Yahoo Finance (Fallback)'
      }
    };
  } catch (e) {
    return { error: 'Data fetch failed' };
  }
}

// ==================== Historical Data for Indicators ====================
async function fetchHistory(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.CA?range=1y&interval=1d`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    return data.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v !== null) || [];
  } catch (e) { return []; }
}

// ==================== Technical Indicators ====================
const calc = {
  sma: (d, p) => d.length < p ? null : d.slice(-p).reduce((a, b) => a + b, 0) / p,
  ema: (d, p) => {
    if (d.length < p) return null;
    let k = 2 / (p + 1), ema = d.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < d.length; i++) ema = (d[i] - ema) * k + ema;
    return ema;
  },
  rsi: (c, p = 14) => {
    if (c.length < p + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const ch = c[i] - c[i - 1]; ch > 0 ? g += ch : l -= ch; }
    let ag = g / p, al = l / p;
    for (let i = p + 1; i < c.length; i++) {
      const ch = c[i] - c[i - 1];
      ch > 0 ? (ag = (ag * (p - 1) + ch) / p, al = (al * (p - 1)) / p) : (ag = (ag * (p - 1)) / p, al = (al * (p - 1) - ch) / p);
    }
    return al === 0 ? 100 : 100 - (100 / (1 + ag / al));
  },
  macd: (c) => {
    const e12 = calc.ema(c, 12), e26 = calc.ema(c, 26);
    if (!e12 || !e26) return null;
    const line = e12 - e26, vals = [];
    for (let i = 26; i < c.length; i++) {
      const a = calc.ema(c.slice(0, i + 1), 12), b = calc.ema(c.slice(0, i + 1), 26);
      if (a && b) vals.push(a - b);
    }
    const sig = calc.ema(vals, 9);
    return { line, sig, hist: line - sig };
  }
};

// ==================== Filter Logic ====================
async function runFilter(symbol, liveData) {
  const history = await fetchHistory(symbol);
  if (history.length < 50) return { passed: false, score: 0, details: { reason: 'Insufficient history' } };

  const price = liveData.price, volume = liveData.volume, open = liveData.open || history[history.length - 2];
  const checks = {};
  checks.vol = volume > 500000;
  const stab = open ? Math.abs(price - open) / price : 1;
  checks.stab = stab < 0.03;
  const e50 = calc.ema(history, 50), e200 = calc.ema(history, 200);
  checks.trend = e50 && e200 && price > e50 && price > e200;
  const rsi = calc.rsi(history);
  checks.rsi = rsi && rsi >= 45 && rsi <= 60;
  const macd = calc.macd(history);
  checks.macd = macd && Math.abs(macd.hist) < 0.5;

  const passed = Object.values(checks).every(v => v);
  const score = Object.values(checks).filter(v => v).length;
  return { passed, score, details: {
    vol: { pass: checks.vol, val: volume },
    stab: { pass: checks.stab, val: (stab * 100).toFixed(2) + '%' },
    trend: { pass: checks.trend, e50: e50?.toFixed(1), e200: e200?.toFixed(1) },
    rsi: { pass: checks.rsi, val: rsi?.toFixed(1) },
    macd: { pass: checks.macd, val: macd?.hist?.toFixed(3) }
  }};
}

// ==================== Commands ====================
const watchlist = new Map(), srLevels = new Map();

bot.onText(/^\/start$/i, (msg) => {
  bot.sendMessage(msg.chat.id, 'Hegazy Trade Bot (Mubasher + Fallback)\n\nCommands:\n/price SYMBOL\n/filter SYMBOL\n/scan\n/chart SYMBOL\n/add SYMBOL\n/list\n/support SYMBOL PRICE\n/resistance SYMBOL PRICE\n/alerts');
});

bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  const load = await bot.sendMessage(msg.chat.id, 'Fetching data...');
  const res = await fetchMubasher(sym);
  if (res.error) return bot.editMessageText(res.error, { chat_id: msg.chat.id, message_id: load.message_id });
  const d = res.data;
  const icon = d.change >= 0 ? '📈' : '';
  let txt = `📊 ${d.symbol}\n💰 Price: ${d.price.toFixed(2)} ${d.currency}\n${icon} Change: ${d.change.toFixed(2)} (${d.changePercent.toFixed(2)}%)\n Open: ${d.open.toFixed(2)} |  High: ${d.high.toFixed(2)} | 📉 Low: ${d.low.toFixed(2)}\n📦 Vol: ${d.volume.toLocaleString()}\n🌐 Source: ${d.source}`;
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/filter\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  const load = await bot.sendMessage(msg.chat.id, 'Analyzing...');
  const live = await fetchMubasher(sym);
  if (live.error) return bot.editMessageText(live.error, { chat_id: msg.chat.id, message_id: load.message_id });
  const f = await runFilter(sym, live.data);
  const dt = f.details;
  let t = ` FILTER: ${sym}\n💰 Price: ${live.data.price.toFixed(2)}\n\n`;
  t += (dt.vol.pass?'✅':'') + ` Volume: ${dt.vol.val.toLocaleString()}\n`;
  t += (dt.stab.pass?'✅':'❌') + ` Stability: ${dt.stab.val} (<3%)\n`;
  t += (dt.trend.pass?'✅':'') + ` Trend: > EMA50(${dt.trend.e50}) & EMA200(${dt.trend.e200})\n`;
  t += (dt.rsi.pass?'✅':'') + ` RSI: ${dt.rsi.val} (45-60)\n`;
  t += (dt.macd.pass?'✅':'❌') + ` MACD: ${dt.macd.val} (~0)\n\n📊 Score: ${f.score}/5\n`;
  if (f.passed) t += '🚀 PERFECT SIGNAL'; else if (f.score >= 4) t += '✅ Strong Candidate';
  t += `\n📈 Chart: ${tvLink(sym)}`;
  bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/scan$/i, async (msg) => {
  const load = await bot.sendMessage(msg.chat.id, 'Scanning EGX... (~40s)');
  let buys = [], watch = [];
  const syms = Object.keys(STOCKS);
  for (let i = 0; i < syms.length; i++) {
    const live = await fetchMubasher(syms[i]);
    if (live.ok) {
      const f = await runFilter(syms[i], live.data);
      if (f.passed) buys.push(`${syms[i]}(${live.data.price.toFixed(2)})`);
      else if (f.score >= 4) watch.push(`${syms[i]}(${f.score}/5)`);
    }
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 1200));
  }
  let t = '🌍 EGX SCAN\n\n🟢 BUY SIGNALS:\n' + (buys.join(', ') || 'None') + '\n\n WATCH LIST:\n' + (watch.join(', ') || 'None');
  bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/chart\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  bot.sendMessage(msg.chat.id, `📈 ${sym} on TradingView:\n${tvLink(sym)}`);
});

bot.onText(/^\/add\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  if (!watchlist.has(msg.chat.id)) watchlist.set(msg.chat.id, []);
  const list = watchlist.get(msg.chat.id);
  if (!list.includes(sym)) { list.push(sym); bot.sendMessage(msg.chat.id, `✅ Added ${sym}`); }
  else bot.sendMessage(msg.chat.id, '️ Already exists');
});

bot.onText(/^\/list$/i, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  bot.sendMessage(msg.chat.id, list.length ? '👀 Watchlist:\n' + list.join('\n') : ' Empty');
});

bot.onText(/^\/(support|resistance)\s+(\w+)\s+([\d.]+)$/i, (msg, match) => {
  const type = match[1], symbol = match[2].toUpperCase(), price = parseFloat(match[3]);
  const cid = msg.chat.id;
  if (!STOCKS[symbol]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  if (!srLevels.has(cid)) srLevels.set(cid, {});
  if (!srLevels.get(cid)[symbol]) srLevels.get(cid)[symbol] = { support: [], resistance: [] };
  srLevels.get(cid)[symbol][type === 'support' ? 'support' : 'resistance'].push(price);
  bot.sendMessage(msg.chat.id, `✅ Set ${type} for ${symbol} at ${price}`);
});

bot.onText(/^\/alerts$/i, (msg) => {
  const levels = srLevels.get(msg.chat.id);
  if (!levels) return bot.sendMessage(msg.chat.id, '📭 No active alerts');
  let t = '🔔 Your Alerts:\n';
  for (const [sym, lvls] of Object.entries(levels)) {
    if (lvls.support.length) t += `🟢 ${sym} Support: ${lvls.support.join(', ')}\n`;
    if (lvls.resistance.length) t += `🔴 ${sym} Resistance: ${lvls.resistance.join(', ')}\n`;
  }
  bot.sendMessage(msg.chat.id, t);
});

setInterval(async () => {
  const now = new Date();
  if ([5,6].includes(now.getDay()) || now.getHours() < 10 || now.getHours() >= 15) return;
  for (const [cid, list] of watchlist) {
    for (const sym of list) {
      try {
        const live = await fetchMubasher(sym);
        if (live.ok) {
          const f = await runFilter(sym, live.data);
          if (f.passed) bot.sendMessage(cid, ` ${sym} hit filter!\n ${live.data.price.toFixed(2)} EGP\nScore: ${f.score}/5`);
        }
      } catch(e) { continue; }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}, 600000);

console.log('✅ Hegazy Trade Bot (Mubasher + Fallback) Started');