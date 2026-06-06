const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 دقائق

function getCached(sym) {
  const item = cache.get(sym);
  return (item && Date.now() - item.time < CACHE_TTL) ? item.data : null;
}
function setCache(sym, data) { cache.set(sym, { data, time: Date.now() }); }

// كل أسهم البورصة المصرية (رموز TradingView الرسمية)
const STOCKS = {
  'COMI':'EGX:COMI','EGBN':'EGX:EGBN','ABUK':'EGX:ABUK','ALEX':'EGX:ALEX','CAIB':'EGX:CAIB',
  'CIHB':'EGX:CIHB','EBNK':'EGX:EBNK','EKBN':'EGX:EKBN','NSGB':'EGX:NSGB','SAIB':'EGX:SAIB',
  'PHDC':'EGX:PHDC','TMGH':'EGX:TMGH','SODIC':'EGX:SODIC','MNHD':'EGX:MNHD','OBEL':'EGX:OBEL',
  'OCDI':'EGX:OCDI','FWRY':'EGX:FWRY','EKHO':'EGX:EKHO','EKZN':'EGX:EKZN','HELI':'EGX:HELI',
  'LXIN':'EGX:LXIN','MOPH':'EGX:MOPH','NILE':'EGX:NILE','QALY':'EGX:QALY','PALM':'EGX:PALM',
  'EFID':'EGX:EFID','EAST':'EGX:EAST','ORWE':'EGX:ORWE','JUFO':'EGX:JUFO','ZMZA':'EGX:ZMZA',
  'KARO':'EGX:KARO','HOD':'EGX:HOD','DOMT':'EGX:DOMT','PHCI':'EGX:PHCI','RMDA':'EGX:RMDA',
  'ISPH':'EGX:ISPH','UNIP':'EGX:UNIP','MKPH':'EGX:MKPH','EIPIC':'EGX:EIPIC','ETEL':'EGX:ETEL',
  'TELS':'EGX:TELS','ITPAC':'EGX:ITPAC','SWDY':'EGX:SWDY','HRHO':'EGX:HRHO','ESRS':'EGX:ESRS',
  'MCDR':'EGX:MCDR','SKPC':'EGX:SKPC','APPC':'EGX:APPC','OLFI':'EGX:OLFI','TALM':'EGX:TALM',
  'UPFD':'EGX:UPFD','WUFA':'EGX:WUFA','YRGN':'EGX:YRGN','ZOD':'EGX:ZOD','INEG':'EGX:INEG',
  'LUTS':'EGX:LUTS','AGRI':'EGX:AGRI','CEMI':'EGX:CEMI','CHEM':'EGX:CHEM','CLHO':'EGX:CLHO',
  'EGAS':'EGX:EGAS','ETRA':'EGX:ETRA','FERT':'EGX:FERT','GAS':'EGX:GAS','GLBC':'EGX:GLBC',
  'IRON':'EGX:IRON','MINA':'EGX:MINA','MNQC':'EGX:MNQC','PACK':'EGX:PACK','PAPR':'EGX:PAPR',
  'PLAS':'EGX:PLAS','POLY':'EGX:POLY','RUBR':'EGX:RUBR','SAND':'EGX:SAND','SHMD':'EGX:SHMD',
  'STLT':'EGX:STLT','TEXT':'EGX:TEXT','TILE':'EGX:TILE','TIMB':'EGX:TIMB','AUTO':'EGX:AUTO',
  'SPIN':'EGX:SPIN','EGTS':'EGX:EGTS','THMD':'EGX:THMD','ALHE':'EGX:ALHE','HOTL':'EGX:HOTL',
  'TOUR':'EGX:TOUR','TRVL':'EGX:TRVL','ELEC':'EGX:ELEC','ENER':'EGX:ENER','FINS':'EGX:FINS',
  'HOLD':'EGX:HOLD','INVS':'EGX:INVS','LEAS':'EGX:LEAS','REIT':'EGX:REIT','SUKN':'EGX:SUKN'
};

// رابط TradingView المباشر لكل سهم
const tvLink = (sym) => `https://www.tradingview.com/chart/?symbol=${STOCKS[sym]}`;

// المؤشرات الفنية (نفس المعادلات الدقيقة)
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

// جلب البيانات (للفلتر والمسح فقط)
async function fetchQuote(symbol) {
  const cached = getCached(symbol);
  if (cached) return { ok: true, data: cached };

  const ticker = STOCKS[symbol.toUpperCase()];
  if (!ticker) return { error: 'Symbol not supported' };

  try {
    // نستخدم Yahoo فقط في الخلفية لحساب المؤشرات (مصدر مجاني مستقر للبيانات التاريخية)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker.replace('EGX:','')}.CA?range=1y&interval=1d`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
    const res = data.chart?.result?.[0];
    if (!res || !res.meta) return { error: 'No data' };

    const m = res.meta, q = res.indicators?.quote?.[0];
    const closes = (q?.close || []).filter(v => v !== null);
    const volumes = (q?.volume || []).filter(v => v !== null);
    const opens = (q?.open || []).filter(v => v !== null);
    const price = m.regularMarketPrice || closes[closes.length - 1];
    const prev = m.previousClose || closes[closes.length - 2] || price;

    const obj = {
      symbol: symbol.toUpperCase(), price, change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      currency: 'EGP', volume: m.regularMarketVolume || volumes[volumes.length - 1] || 0,
      closes, volumes, opens
    };
    setCache(symbol, obj);
    return { ok: true, data: obj };
  } catch (e) {
    return { error: 'Data fetch error' };
  }
}

// الفلتر المتقدم
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
  checks.macd = macd && Math.abs(macd.hist) < 0.1;
  const passed = Object.values(checks).every(v => v);
  const score = Object.values(checks).filter(v => v).length;
  return { passed, score, details: {
    vol: { pass: checks.vol, val: volume, thr: smaV ? Math.round(smaV * 1.2) : null },
    stab: { pass: checks.stab, val: (stab * 100).toFixed(2) + '%' },
    trend: { pass: checks.trend, e50: e50?.toFixed(1), e200: e200?.toFixed(1) },
    rsi: { pass: checks.rsi, val: rsi?.toFixed(1) },
    macd: { pass: checks.macd, val: macd?.hist?.toFixed(3) }
  }};
}

// الأوامر
const watchlist = new Map();
const srLevels = new Map();

bot.onText(/^\/start$/i, (msg) => {
  let t = 'Hegazy Trade Bot (TradingView Edition)\n\n';
  t += 'Commands:\n';
  t += '/price SYMBOL - View Chart & Basic Info\n';
  t += '/filter SYMBOL - Technical Analysis\n';
  t += '/scan - Market Scan\n';
  t += '/chart SYMBOL - Open TradingView Chart\n';
  t += '/add SYMBOL - Watchlist\n/list\n/support\n/resistance\n/alerts\n\n';
  t += 'Example: /filter EFID';
  bot.sendMessage(msg.chat.id, t);
});

bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  const load = await bot.sendMessage(msg.chat.id, 'Loading...');
  const res = await fetchQuote(sym);
  if (res.error) return bot.editMessageText(res.error, { chat_id: msg.chat.id, message_id: load.message_id });
  
  const d = res.data;
  const icon = d.change >= 0 ? '📈' : '📉';
  let txt = `${d.symbol}\nPrice: ${d.price.toFixed(2)} ${d.currency}\n`;
  txt += `${icon} Change: ${d.change.toFixed(2)} (${d.changePercent.toFixed(2)}%)\n`;
  txt += `Vol: ${d.volume.toLocaleString()}\n\n`;
  txt += `📊 View Live Chart: ${tvLink(sym)}`;
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/chart\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  bot.sendMessage(msg.chat.id, `📈 Open ${sym} on TradingView:\n${tvLink(sym)}`);
});

bot.onText(/^\/filter\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, 'Analyzing...');
  const res = await fetchQuote(sym);
  if (res.error) return bot.editMessageText(res.error, { chat_id: msg.chat.id, message_id: load.message_id });
  
  const f = runFilter(res.data);
  const dt = f.details;
  let t = `FILTER: ${sym}\nPrice: ${res.data.price.toFixed(2)}\n\n`;
  t += (dt.vol.pass?'✅':'❌') + ` Volume: ${dt.vol.val}${dt.vol.thr?' (Need: '+dt.vol.thr+')':''}\n`;
  t += (dt.stab.pass?'✅':'❌') + ` Stability: ${dt.stab.val} (<2%)\n`;
  t += (dt.trend.pass?'✅':'❌') + ` Trend: > EMA50(${dt.trend.e50}) & EMA200(${dt.trend.e200})\n`;
  t += (dt.rsi.pass?'✅':'❌') + ` RSI: ${dt.rsi.val} (48-55)\n`;
  t += (dt.macd.pass?'✅':'❌') + ` MACD: ${dt.macd.val} (~0)\n\n`;
  t += `Score: ${f.score}/5\n`;
  if (f.passed) t += '\n*** PERFECT BUY SIGNAL ***';
  else if (f.score >= 4) t += '\n* Strong Candidate *';
  t += `\n\n📊 Chart: ${tvLink(sym)}`;
  bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/scan$/i, async (msg) => {
  const load = await bot.sendMessage(msg.chat.id, 'Scanning market... (60s)');
  let buys = [], watch = [];
  const symbols = Object.keys(STOCKS);
  for (let i = 0; i < symbols.length; i++) {
    const res = await fetchQuote(symbols[i]);
    if (res.ok) {
      const f = runFilter(res.data);
      if (f.passed) buys.push(`${symbols[i]}(${res.data.price.toFixed(2)})`);
      else if (f.score >= 4) watch.push(`${symbols[i]}(${f.score}/5)`);
    }
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 800));
  }
  let t = 'MARKET SCAN\n\n';
  t += `BUY SIGNALS (${buys.length}):\n${buys.join(', ') || 'None'}\n\n`;
  t += `WATCH LIST (${watch.length}):\n${watch.join(', ') || 'None'}`;
  bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
});

// باقي الأوامر (add, list, support, resistance, alerts) نفس السابقة مع تحديث الروابط
bot.onText(/^\/add\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  if (!watchlist.has(msg.chat.id)) watchlist.set(msg.chat.id, []);
  const list = watchlist.get(msg.chat.id);
  if (!list.includes(sym)) { list.push(sym); bot.sendMessage(msg.chat.id, 'Added ' + sym + `\nChart: ${tvLink(sym)}`); }
  else bot.sendMessage(msg.chat.id, 'Already exists');
});

bot.onText(/^\/list$/i, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  bot.sendMessage(msg.chat.id, list.length ? 'Watchlist:\n' + list.map(s => `${s} → ${tvLink(s)}`).join('\n') : 'Empty');
});

bot.onText(/^\/(support|resistance)\s+(\w+)\s+([\d.]+)$/i, (msg, match) => {
  const type = match[1], symbol = match[2].toUpperCase(), price = parseFloat(match[3]);
  const cid = msg.chat.id;
  if (!STOCKS[symbol]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  if (!srLevels.has(cid)) srLevels.set(cid, {});
  if (!srLevels.get(cid)[symbol]) srLevels.get(cid)[symbol] = { support: [], resistance: [] };
  srLevels.get(cid)[symbol][type === 'support' ? 'support' : 'resistance'].push(price);
  bot.sendMessage(msg.chat.id, `Set ${type} for ${symbol} at ${price}\nChart: ${tvLink(symbol)}`);
});

bot.onText(/^\/alerts$/i, (msg) => {
  const levels = srLevels.get(msg.chat.id);
  if (!levels) return bot.sendMessage(msg.chat.id, 'No alerts set');
  let t = 'Your Alerts:\n';
  for (const [sym, lvls] of Object.entries(levels)) {
    if (lvls.support.length) t += `🟢 ${sym} Support: ${lvls.support.join(', ')}\n`;
    if (lvls.resistance.length) t += `🔴 ${sym} Resistance: ${lvls.resistance.join(', ')}\n`;
  }
  bot.sendMessage(msg.chat.id, t);
});

// فحص دوري كل 10 دقائق
setInterval(async () => {
  const now = new Date();
  const day = now.getDay(), hour = now.getHours();
  if ([5,6].includes(day) || hour < 10 || hour >= 15) return;
  
  for (const [cid, list] of watchlist) {
    for (const sym of list) {
      try {
        const res = await fetchQuote(sym);
        if (res.ok) {
          const f = runFilter(res.data);
          if (f.passed) bot.sendMessage(cid, `🚨 ${sym} hit filter!\nPrice: ${res.data.price.toFixed(2)}\nChart: ${tvLink(sym)}`);
        }
      } catch(e) { continue; }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}, 600000);

console.log('Hegazy Trade Bot (TradingView Edition) Started');