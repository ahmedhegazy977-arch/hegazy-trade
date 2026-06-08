const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // دقيقتين

function getCached(sym) {
  const item = cache.get(sym);
  return (item && Date.now() - item.time < CACHE_TTL) ? item.data : null;
}
function setCache(sym, data) { cache.set(sym, { data, time: Date.now() }); }

// قائمة أسهم EGX
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

// ==================== Scraping مباشر ====================
async function fetchMubasher(symbol) {
  const cached = getCached(symbol);
  if (cached) return { ok: true, data: cached };

  try {
    const url = `https://www.mubasher.info/markets/EGX/stocks/${symbol}/`;
    const { data: html } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 12000
    });

    const $ = cheerio.load(html);
    
    // استخراج البيانات بطرق متعددة لضمان الاستقرار
    const price = parseFloat($('meta[property="og:price:amount"]').attr('content')) || 
                  parseFloat($('.stock-price__value').first().text().replace(/,/g, '')) || null;
                  
    if (!price) throw new Error('Price not found');

    const changeText = $('.stock-change__value').first().text() || $('meta[property="og:price:change"]').attr('content');
    const change = parseFloat((changeText || '0').replace(/[^0-9.-]/g, ''));
    
    const changePctText = $('.stock-change-percent__value').first().text() || $('meta[property="og:price:change_percent"]').attr('content');
    const changePercent = parseFloat((changePctText || '0').replace(/[^0-9.-]/g, ''));

    const volumeText = $('[data-testid="volume"] .value').text() || $('.market-stats__item:contains("حجم التداول") .value').text();
    const volume = parseInt((volumeText || '0').replace(/[^0-9]/g, ''));

    const high = parseFloat($('.market-stats__item:contains("أعلى") .value').text().replace(/,/g, '')) || 0;
    const low = parseFloat($('.market-stats__item:contains("أدنى") .value').text().replace(/,/g, '')) || 0;
    const open = parseFloat($('.market-stats__item:contains("افتتاح") .value').text().replace(/,/g, '')) || 0;
    const prevClose = parseFloat($('.market-stats__item:contains("إغلاق سابق") .value').text().replace(/,/g, '')) || price - change;

    const obj = {
      symbol: symbol.toUpperCase(),
      price, change, changePercent, volume,
      high, low, open, prevClose,
      currency: 'EGP',
      source: 'Mubasher.info'
    };

    setCache(symbol, obj);
    return { ok: true, data: obj };
  } catch (e) {
    return { error: 'Mubasher fetch error: ' + e.message };
  }
}

// ==================== Historical Fallback (للمؤشرات الفنية فقط) ====================
// نستخدم Yahoo فقط لجلب الإغلاقات التاريخية لحساب RSI/EMA/MACD بدقة
async function fetchHistoryForIndicators(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.CA?range=1y&interval=1d`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v !== null) || [];
    return closes;
  } catch (e) {
    return [];
  }
}

// ==================== المؤشرات الفنية ====================
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

// ==================== الفلتر المتقدم ====================
async function runFilter(symbol, liveData) {
  const history = await fetchHistoryForIndicators(symbol);
  if (history.length < 50) return { passed: false, score: 0, details: { reason: 'Insufficient history' } };

  const price = liveData.price;
  const volume = liveData.volume;
  const open = liveData.open || history[history.length - 2];
  
  const checks = {};
  const smaV = calc.sma(history.slice(-20).map((_, i) => liveData.volume || 0), 20); // حجم الجلسة كمؤشر أولي
  checks.vol = volume > 500000; // سيولة أساسية
  
  const stab = open ? Math.abs(price - open) / price : 1;
  checks.stab = stab < 0.03; // مرونة أكبر للأسهم المصرية
  
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

// ==================== أوامر البوت ====================
const watchlist = new Map();
const srLevels = new Map();

bot.onText(/^\/start$/i, (msg) => {
  let t = 'Hegazy Trade Bot (Mubasher Edition)\n\n';
  t += 'Commands:\n';
  t += '/price SYMBOL - Live Mubasher Data\n';
  t += '/filter SYMBOL - Technical Analysis\n';
  t += '/scan - Market Scan\n';
  t += '/chart SYMBOL - TradingView Link\n';
  t += '/add SYMBOL - Watchlist\n/list\n/support\n/resistance\n/alerts';
  bot.sendMessage(msg.chat.id, t);
});

bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  const load = await bot.sendMessage(msg.chat.id, 'Fetching from Mubasher...');
  const res = await fetchMubasher(sym);
  if (res.error) return bot.editMessageText(res.error, { chat_id: msg.chat.id, message_id: load.message_id });
  
  const d = res.data;
  const icon = d.change >= 0 ? '📈' : '📉';
  let txt = `📊 ${d.symbol}\n`;
  txt += `💰 Price: ${d.price.toFixed(2)} ${d.currency}\n`;
  txt += `${icon} Change: ${d.change.toFixed(2)} (${d.changePercent.toFixed(2)}%)\n`;
  txt += ` Open: ${d.open.toFixed(2)} | 📈 High: ${d.high.toFixed(2)} | 📉 Low: ${d.low.toFixed(2)}\n`;
  txt += `📦 Vol: ${d.volume.toLocaleString()}\n`;
  txt += ` Source: ${d.source}`;
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/filter\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  const load = await bot.sendMessage(msg.chat.id, 'Analyzing with Mubasher data...');
  const liveRes = await fetchMubasher(sym);
  if (liveRes.error) return bot.editMessageText(liveRes.error, { chat_id: msg.chat.id, message_id: load.message_id });
  
  const filter = await runFilter(sym, liveRes.data);
  const dt = filter.details;
  
  let t = `🎯 FILTER: ${sym}\n💰 Price: ${liveRes.data.price.toFixed(2)}\n\n`;
  t += (dt.vol.pass?'✅':'❌') + ` Volume: ${dt.vol.val.toLocaleString()}\n`;
  t += (dt.stab.pass?'✅':'❌') + ` Stability: ${dt.stab.val} (<3%)\n`;
  t += (dt.trend.pass?'✅':'❌') + ` Trend: > EMA50(${dt.trend.e50}) & EMA200(${dt.trend.e200})\n`;
  t += (dt.rsi.pass?'✅':'❌') + ` RSI: ${dt.rsi.val} (45-60)\n`;
  t += (dt.macd.pass?'✅':'❌') + ` MACD: ${dt.macd.val} (~0)\n\n`;
  t += `📊 Score: ${filter.score}/5\n`;
  if (filter.passed) t += '\n🚀 PERFECT ACCUMULATION SIGNAL';
  else if (filter.score >= 4) t += '\n✅ Strong Candidate';
  t += `\n\n📈 Chart: ${tvLink(sym)}`;
  bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/scan$/i, async (msg) => {
  const load = await bot.sendMessage(msg.chat.id, 'Scanning EGX via Mubasher... (wait ~45s)');
  let buys = [], watch = [];
  const symbols = Object.keys(STOCKS);
  for (let i = 0; i < symbols.length; i++) {
    const live = await fetchMubasher(symbols[i]);
    if (live.ok) {
      const f = await runFilter(symbols[i], live.data);
      if (f.passed) buys.push(`${symbols[i]}(${live.data.price.toFixed(2)})`);
      else if (f.score >= 4) watch.push(`${symbols[i]}(${f.score}/5)`);
    }
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 1000)); // Delay to avoid blocking
  }
  let t = '🌍 EGX SCAN REPORT\n\n';
  t += `🟢 BUY SIGNALS (${buys.length}):\n${buys.join(', ') || 'None'}\n\n`;
  t += ` WATCH LIST (${watch.length}):\n${watch.join(', ') || 'None'}`;
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
  else bot.sendMessage(msg.chat.id, '⚠️ Already exists');
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

// فحص دوري
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

console.log('✅ Hegazy Trade Bot (Mubasher Edition) Started');