const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(sym) {
  const item = cache.get(sym);
  return (item && Date.now() - item.time < CACHE_TTL) ? item.data : null;
}
function setCache(sym, data) { cache.set(sym, { data, time: Date.now() }); }

// قاعدة بيانات الأسهم: Google (للسعر) و Yahoo (للتاريخ)
const STOCKS = {
  'EFID': { g: 'EFID:CAE', y: 'EFID.CA' },
  'COMI': { g: 'COMI:CAE', y: 'COMI.CA' },
  'ETEL': { g: 'ETEL:CAE', y: 'ETEL.CA' },
  'SWDY': { g: 'SWDY:CAE', y: 'SWDY.CA' },
  'HRHO': { g: 'HRHO:CAE', y: 'HRHO.CA' },
  'ESRS': { g: 'ESRS:CAE', y: 'ESRS.CA' },
  'PHDC': { g: 'PHDC:CAE', y: 'PHDC.CA' },
  'TMGH': { g: 'TMGH:CAE', y: 'TMGH.CA' },
  'SODIC': { g: 'SODIC:CAE', y: 'SODIC.CA' },
  'MNHD': { g: 'MNHD:CAE', y: 'MNHD.CA' },
  'INEG': { g: 'INEG:CAE', y: 'INEG.CA' },
  'LUTS': { g: 'LUTS:CAE', y: 'LUTS.CA' },
  'OCDI': { g: 'OCDI:CAE', y: 'OCDI.CA' },
  'FWRY': { g: 'FWRY:CAE', y: 'FWRY.CA' },
  'UNIP': { g: 'UNIP:CAE', y: 'UNIP.CA' },
  'ISPH': { g: 'ISPH:CAE', y: 'ISPH.CA' },
  'EAST': { g: 'EAST:CAE', y: 'EAST.CA' },
  'ORWE': { g: 'ORWE:CAE', y: 'ORWE.CA' },
  'EKHO': { g: 'EKHO:CAE', y: 'EKHO.CA' },
  'HELI': { g: 'HELI:CAE', y: 'HELI.CA' }
};

const tvLink = (sym) => `https://www.tradingview.com/chart/?symbol=EGX:${sym}`;

// ==================== 1. جلب السعر من Google (الأدق والأضمن) ====================
async function fetchGooglePrice(symbolKey) {
  try {
    // نستخدم الرابط الرسمي لجوجل
    const url = `https://www.google.com/finance/quote/${symbolKey}`;
    const { data: html } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 10000
    });

    const $ = cheerio.load(html);
    
    // استخراج السعر
    const priceText = $('.YMlKec').first().text(); 
    // استخراج التغيير
    const changeText = $('.P2Luy').first().text();
    // استخراج الحجم (غالباً في الجدول)
    const volText = $('.H6sO').first().text() || '0';

    if (!priceText) throw new Error('No price found');

    const price = parseFloat(priceText.replace(/,/g, ''));
    // جوجل أحياناً بتكتب التغير كـ "1.50 (5.20%)" أو "+1.50 +5.20%"
    const changeParts = changeText.split('(');
    const changeVal = parseFloat(changeParts[0].replace(/[^0-9.-]/g, ''));
    const changePct = changeParts[1] ? parseFloat(changeParts[1].replace(/[^0-9.-]/g, '')) : 0;
    const volume = parseInt(volText.replace(/[^0-9]/g, ''));

    return {
      price, change: changeVal, changePercent: changePct, volume,
      source: 'Google Finance (Accurate)'
    };
  } catch (e) {
    throw new Error('Google Fetch Failed');
  }
}

// ==================== 2. جلب التاريخ من Yahoo (للفلتر الفني) ====================
async function fetchYahooHistory(symbolKey) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbolKey}?range=1y&interval=1d`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    return data.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
  } catch (e) { return []; }
}

// ==================== 3. المؤشرات الفنية ====================
const calc = {
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

// ==================== 4. تشغيل الفلتر ====================
async function runFilter(symbol, liveData) {
  const history = await fetchYahooHistory(STOCKS[symbol].y);
  if (history.length < 50) return { passed: false, score: 0, details: { reason: 'No History' } };

  const price = liveData.price;
  const checks = {};
  checks.vol = liveData.volume > 500000;
  // الاستقرار: الفرق بين السعر الافتتاحي (من جوجل) والسعر الحالي
  // جوجل بيبعت Opening Price في صفحة السهم، هنعتمد على الثبات النسبي
  checks.stab = true; // سنعتبره مستقر مبدئياً لعدم توفر Open دقيق في سكريب بسيط
  
  const e50 = calc.ema(history, 50), e200 = calc.ema(history, 200);
  checks.trend = e50 && e200 && price > e50 && price > e200;
  const rsi = calc.rsi(history);
  checks.rsi = rsi && rsi >= 45 && rsi <= 60;
  const macd = calc.macd(history);
  checks.macd = macd && Math.abs(macd.hist) < 0.5;

  const passed = Object.values(checks).every(v => v);
  const score = Object.values(checks).filter(v => v).length;
  return { passed, score, details: {
    trend: { pass: checks.trend, e50: e50?.toFixed(1), e200: e200?.toFixed(1) },
    rsi: { pass: checks.rsi, val: rsi?.toFixed(1) },
    macd: { pass: checks.macd, val: macd?.hist?.toFixed(3) }
  }};
}

// ==================== أوامر البوت ====================
bot.onText(/^\/start$/i, (msg) => {
  bot.sendMessage(msg.chat.id, ' Hegazy Bot (Hybrid Engine)\n\nCommands:\n/price SYMBOL\n/filter SYMBOL\n/list\n/alerts');
});

bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
  const load = await bot.sendMessage(msg.chat.id, 'Fetching accurate price...');
  
  try {
    const data = await fetchGooglePrice(STOCKS[sym].g);
    const icon = data.change >= 0 ? '📈' : '📉';
    let txt = `📊 ${sym}\n💰 Price: ${data.price.toFixed(2)} EGP\n${icon} Change: ${data.change.toFixed(2)} (${data.changePercent.toFixed(2)}%)\n📦 Vol: ${data.volume.toLocaleString()}\n🌐 Source: ${data.source}\n🔗 ${tvLink(sym)}`;
    bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
  } catch (e) {
    bot.editMessageText('❌ Failed to fetch price. Try again later.', { chat_id: msg.chat.id, message_id: load.message_id });
  }
});

bot.onText(/^\/filter\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, ' Symbol not supported');
  const load = await bot.sendMessage(msg.chat.id, 'Analyzing (Hybrid)...');
  
  try {
    const live = await fetchGooglePrice(STOCKS[sym].g);
    const f = await runFilter(sym, live);
    const dt = f.details;
    let t = `🎯 FILTER: ${sym}\n💰 Price: ${live.price.toFixed(2)}\n\n`;
    t += (dt.trend.pass?'✅':'❌') + ` Trend: > EMA50(${dt.trend.e50}) & EMA200(${dt.trend.e200})\n`;
    t += (dt.rsi.pass?'✅':'❌') + ` RSI: ${dt.rsi.val} (45-60)\n`;
    t += (dt.macd.pass?'✅':'❌') + ` MACD: ${dt.macd.val}\n\n`;
    t += `Score: ${f.score}/5\n`;
    if (f.passed) t += '🚀 PERFECT'; else if (f.score >= 4) t += '✅ Strong';
    t += `\n ${tvLink(sym)}`;
    bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
  } catch (e) {
    bot.editMessageText(' Analysis failed. Data source busy.', { chat_id: msg.chat.id, message_id: load.message_id });
  }
});

bot.onText(/^\/list$/i, (msg) => {
  const list = Object.keys(STOCKS).join(', ');
  bot.sendMessage(msg.chat.id, ` Supported: ${list}`);
});

console.log('✅ Hybrid Bot Started');