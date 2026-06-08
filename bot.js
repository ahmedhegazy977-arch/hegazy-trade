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

const STOCKS = {
  'COMI':'COMI.CA','EGBN':'EGBN.CA','ABUK':'ABUK.CA','ALEX':'ALEX.CA','CAIB':'CAIB.CA',
  'CIHB':'CIHB.CA','EBNK':'EBNK.CA','EKBN':'EKBN.CA','NSGB':'NSGB.CA','SAIB':'SAIB.CA',
  'PHDC':'PHDC.CA','TMGH':'TMGH.CA','SODIC':'SODIC.CA','MNHD':'MNHD.CA','OBEL':'OBEL.CA',
  'OCDI':'OCDI.CA','FWRY':'FWRY.CA','EKHO':'EKHO.CA','EKZN':'EKZN.CA','HELI':'HELI.CA',
  'LXIN':'LXIN.CA','MOPH':'MOPH.CA','NILE':'NILE.CA','QALY':'QALY.CA','PALM':'PALM.CA',
  'EFID':'EFID.CA','EAST':'EAST.CA','ORWE':'ORWE.CA','JUFO':'JUFO.CA','ZMZA':'ZMZA.CA',
  'KARO':'KARO.CA','HOD':'HOD.CA','DOMT':'DOMT.CA','PHCI':'PHCI.CA','RMDA':'RMDA.CA',
  'ISPH':'ISPH.CA','UNIP':'UNIP.CA','MKPH':'MKPH.CA','EIPIC':'EIPIC.CA','ETEL':'ETEL.CA',
  'TELS':'TELS.CA','ITPAC':'ITPAC.CA','SWDY':'SWDY.CA','HRHO':'HRHO.CA','ESRS':'ESRS.CA',
  'MCDR':'MCDR.CA','SKPC':'SKPC.CA','APPC':'APPC.CA','OLFI':'OLFI.CA','TALM':'TALM.CA',
  'UPFD':'UPFD.CA','WUFA':'WUFA.CA','YRGN':'YRGN.CA','ZOD':'ZOD.CA','INEG':'INEG.CA',
  'LUTS':'LUTS.CA','AGRI':'AGRI.CA','CEMI':'CEMI.CA','CHEM':'CHEM.CA','CLHO':'CLHO.CA',
  'EGAS':'EGAS.CA','ETRA':'ETRA.CA','FERT':'FERT.CA','GAS':'GAS.CA','GLBC':'GLBC.CA',
  'IRON':'IRON.CA','MINA':'MINA.CA','MNQC':'MNQC.CA','PACK':'PACK.CA','PAPR':'PAPR.CA',
  'PLAS':'PLAS.CA','POLY':'POLY.CA','RUBR':'RUBR.CA','SAND':'SAND.CA','SHMD':'SHMD.CA',
  'STLT':'STLT.CA','TEXT':'TEXT.CA','TILE':'TILE.CA','TIMB':'TIMB.CA','AUTO':'AUTO.CA',
  'SPIN':'SPIN.CA','EGTS':'EGTS.CA','THMD':'THMD.CA','ALHE':'ALHE.CA','HOTL':'HOTL.CA',
  'TOUR':'TOUR.CA','TRVL':'TRVL.CA','ELEC':'ELEC.CA','ENER':'ENER.CA','FINS':'FINS.CA',
  'HOLD':'HOLD.CA','INVS':'INVS.CA','LEAS':'LEAS.CA','REIT':'REIT.CA','SUKN':'SUKN.CA'
};

const tvLink = (sym) => `https://www.tradingview.com/chart/?symbol=EGX:${sym.replace('.CA','')}`;

// ==================== جلب بيانات ياهو (مُحسّن للثبات) ====================
async function fetchYahoo(symbol) {
  const cached = getCached(symbol);
  if (cached) return { ok: true, data: cached };

  const ticker = STOCKS[symbol.toUpperCase()];
  if (!ticker) return { error: 'Symbol not supported' };

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=5m`;
    const { data } = await axios.get(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const res = data.chart?.result?.[0];
    if (!res || !res.meta) return { error: 'No data available' };

    const m = res.meta, q = res.indicators?.quote?.[0];
    const closes = (q?.close || []).filter(v => v !== null);
    const volumes = (q?.volume || []).filter(v => v !== null);
    const opens = (q?.open || []).filter(v => v !== null);
    
    const price = m.regularMarketPrice || closes[closes.length - 1];
    const prev = m.previousClose || closes[closes.length - 2] || price;
    const change = price - prev;
    const changePercent = prev ? (change / prev) * 100 : 0;

    const obj = {
      symbol: symbol.toUpperCase(), price, change, changePercent,
      volume: m.regularMarketVolume || volumes[volumes.length - 1] || 0,
      high: m.regularMarketDayHigh || Math.max(...closes),
      low: m.regularMarketDayLow || Math.min(...closes),
      open: opens[0] || price,
      prevClose: prev,
      currency: 'EGP',
      closes, // محتاجة للفلتر الفني
      source: 'Yahoo Finance (15m delay)'
    };
    setCache(symbol, obj);
    return { ok: true, data: obj };
  } catch (e) {
    return { error: 'Data fetch failed' };
  }
}

// ==================== المؤشرات الفنية (دقيقة 100% لأنها تعتمد على الإغلاقات اليومية) ====================
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

async function fetchHistory(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${STOCKS[symbol]}?range=1y&interval=1d`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    return data.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v !== null) || [];
  } catch (e) { return []; }
}

async function runFilter(symbol, liveData) {
  const history = await fetchHistory(symbol);
  if (history.length < 50) return { passed: false, score: 0, details: { reason: 'Insufficient history' } };

  const price = liveData.price, volume = liveData.volume, open = liveData.open;
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

// ==================== أوامر البوت ====================
const watchlist = new Map(), srLevels = new Map();

bot.onText(/^\/start$/i, (msg) => {
  bot.sendMessage(msg.chat.id, '🤖 Hegazy Trade Bot (Stable v6)\n\n Commands:\n/price SYMBOL\n/filter SYMBOL\n/scan\n/chart SYMBOL\n/add SYMBOL\n/list\n/support SYMBOL PRICE\n/resistance SYMBOL PRICE\n/alerts\n\n⚠️ Data delayed ~15m. Verify live price via /chart');
});

bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
  const load = await bot.sendMessage(msg.chat.id, ' Fetching...');
  const res = await fetchYahoo(sym);
  if (res.error) return bot.editMessageText('❌ ' + res.error, { chat_id: msg.chat.id, message_id: load.message_id });
  const d = res.data;
  const icon = d.change >= 0 ? '📈' : '📉';
  let txt = `📊 ${d.symbol}\n💰 Price: ${d.price.toFixed(2)} ${d.currency}\n${icon} Change: ${d.change.toFixed(2)} (${d.changePercent.toFixed(2)}%)\n📦 Vol: ${d.volume.toLocaleString()}\n🌐 ${d.source}\n🔗 Live Chart: ${tvLink(sym)}`;
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/filter\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
  const load = await bot.sendMessage(msg.chat.id, '🔍 Analyzing...');
  const live = await fetchYahoo(sym);
  if (live.error) return bot.editMessageText('❌ ' + live.error, { chat_id: msg.chat.id, message_id: load.message_id });
  const f = await runFilter(sym, live.data);
  const dt = f.details;
  let t = `🎯 FILTER: ${sym}\n Price: ${live.data.price.toFixed(2)}\n\n`;
  t += (dt.vol.pass?'✅':'❌') + ` Volume: ${dt.vol.val.toLocaleString()}\n`;
  t += (dt.stab.pass?'✅':'❌') + ` Stability: ${dt.stab.val} (<3%)\n`;
  t += (dt.trend.pass?'✅':'❌') + ` Trend: > EMA50(${dt.trend.e50}) & EMA200(${dt.trend.e200})\n`;
  t += (dt.rsi.pass?'✅':'❌') + ` RSI: ${dt.rsi.val} (45-60)\n`;
  t += (dt.macd.pass?'✅':'❌') + ` MACD: ${dt.macd.val} (~0)\n\n Score: ${f.score}/5\n`;
  if (f.passed) t += '🚀 PERFECT SIGNAL'; else if (f.score >= 4) t += '✅ Strong Candidate';
  t += `\n🔗 Verify Live: ${tvLink(sym)}`;
  bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/scan$/i, async (msg) => {
  const load = await bot.sendMessage(msg.chat.id, ' Scanning EGX... (~30s)');
  let buys = [], watch = [];
  const syms = Object.keys(STOCKS);
  for (let i = 0; i < syms.length; i++) {
    const live = await fetchYahoo(syms[i]);
    if (live.ok) {
      const f = await runFilter(syms[i], live.data);
      if (f.passed) buys.push(`${syms[i]}(${live.data.price.toFixed(2)})`);
      else if (f.score >= 4) watch.push(`${syms[i]}(${f.score}/5)`);
    }
    if (i % 8 === 0) await new Promise(r => setTimeout(r, 1000));
  }
  let t = '📋 EGX SCAN REPORT\n\n BUY SIGNALS:\n' + (buys.join(', ') || 'None') + '\n\n WATCH LIST:\n' + (watch.join(', ') || 'None');
  bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/chart\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, ' Symbol not supported');
  bot.sendMessage(msg.chat.id, `📈 ${sym} Live Chart:\n${tvLink(sym)}`);
});

bot.onText(/^\/add\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
  if (!watchlist.has(msg.chat.id)) watchlist.set(msg.chat.id, []);
  const list = watchlist.get(msg.chat.id);
  if (!list.includes(sym)) { list.push(sym); bot.sendMessage(msg.chat.id, `✅ Added ${sym}`); }
  else bot.sendMessage(msg.chat.id, '⚠️ Already exists');
});

bot.onText(/^\/list$/i, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  bot.sendMessage(msg.chat.id, list.length ? '👀 Watchlist:\n' + list.join('\n') : '📭 Empty');
});

bot.onText(/^\/(support|resistance)\s+(\w+)\s+([\d.]+)$/i, (msg, match) => {
  const type = match[1], symbol = match[2].toUpperCase(), price = parseFloat(match[3]);
  const cid = msg.chat.id;
  if (!STOCKS[symbol]) return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
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

// فحص دوري كل 10 دقائق
setInterval(async () => {
  const now = new Date();
  if ([5,6].includes(now.getDay()) || now.getHours() < 10 || now.getHours() >= 15) return;
  for (const [cid, list] of watchlist) {
    for (const sym of list) {
      try {
        const live = await fetchYahoo(sym);
        if (live.ok) {
          const f = await runFilter(sym, live.data);
          if (f.passed) bot.sendMessage(cid, `🚨 ${sym} hit filter!\n💰 ${live.data.price.toFixed(2)} EGP\n📊 Score: ${f.score}/5\n🔗 ${tvLink(sym)}`);
        }
      } catch(e) { continue; }
      await new Promise(r => setTimeout(r, 1200));
    }
  }
}, 600000);

console.log('✅ Hegazy Trade Bot (Stable v6) Started');