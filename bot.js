const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// ====== تخزين مؤقت ذكي (يقلل الطلبات ويحمي من الحظر) ======
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // دقيقتين

function getCached(symbol) {
  const item = cache.get(symbol);
  if (item && Date.now() - item.time < CACHE_TTL) return item.data;
  return null;
}

function setCache(symbol, data) {
  cache.set(symbol, { data, time: Date.now() });
  // تنظيف الكاش القديم تلقائياً
  if (cache.size > 200) {
    const keys = Array.from(cache.keys());
    cache.delete(keys[0]);
  }
}

// ====== قائمة شاملة للأسهم المصرية (Yahoo Finance) ======
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

const SECTORS = {
  Banks: ['COMI','EGBN','ABUK','ALEX','CAIB','CIHB','EBNK'],
  RealEstate: ['PHDC','TMGH','SODIC','MNHD','OBEL','OCDI','FWRY','EKHO','HELI','LXIN'],
  Food: ['EFID','EAST','ORWE','JUFO','ZMZA','KARO','HOD','DOMT'],
  Pharma: ['PHCI','RMDA','ISPH','UNIP','MKPH','EIPIC'],
  Telecom: ['ETEL','TELS','ITPAC','SWDY'],
  Materials: ['HRHO','ESRS','MCDR','SKPC','APPC','OLFI','TALM','UPFD','WUFA','YRGN','ZOD','INEG','LUTS','AGRI','CEMI','CHEM','CLHO','EGAS','ETRA','FERT','GAS','GLBC','IRON','MINA','MNQC','PACK','PAPR','PLAS','POLY','RUBR','SAND','SHMD','STLT','TEXT','TILE','TIMB'],
  Services: ['AUTO','SPIN','EGTS','THMD','ALHE','HOTL','TOUR','TRVL','ELEC','ENER','FINS','HOLD','INVS','LEAS','REIT','SUKN']
};

// ====== مؤشرات فنية محسنة ======
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

// ====== جلب البيانات مع حماية من الحظر ======
async function fetchQuote(symbol) {
  const cached = getCached(symbol);
  if (cached) return { ok: true, data: cached };

  const ticker = STOCKS[symbol.toUpperCase()];
  if (!ticker) return { error: 'Symbol not supported' };

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 });
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
      changePercent: ((price - prev) / prev) * 100, currency: m.currency || 'EGP',
      volume: m.regularMarketVolume || volumes[volumes.length - 1] || 0,
      closes, volumes, opens
    };
    setCache(symbol, obj);
    return { ok: true, data: obj };
  } catch (e) {
    return { error: 'API Error: ' + e.message };
  }
}

// ====== الفلتر المتقدم ======
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
  return { passed, score, total: 5, details: {
    vol: { pass: checks.vol, val: volume, thr: smaV ? Math.round(smaV * 1.2) : null },
    stab: { pass: checks.stab, val: (stab * 100).toFixed(2) + '%' },
    trend: { pass: checks.trend, e50: e50?.toFixed(1), e200: e200?.toFixed(1) },
    rsi: { pass: checks.rsi, val: rsi?.toFixed(1) },
    macd: { pass: checks.macd, val: macd?.hist?.toFixed(3) }
  }};
}

// ====== أوامر البوت ======
const watchlist = new Map();
const srLevels = new Map();

bot.onText(/^\/start$/i, (msg) => {
  let t = 'Hegazy Trade Bot v4.0 (Stable)\n\nCommands:\n';
  t += '/price SYMBOL - Live Price\n/filter SYMBOL - Technical Filter\n';
  t += '/scan - Full Market Scan\n/top - Gainers/Losers/Active\n';
  t += '/market - Market Overview\n/add SYMBOL - Watchlist\n/list - View List\n';
  t += '/support SYMBOL PRICE\n/resistance SYMBOL PRICE\n/alerts - View Alerts\n\n';
  t += 'Example: /filter EFID';
  bot.sendMessage(msg.chat.id, t);
});

bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, 'Loading...');
  const res = await fetchQuote(sym);
  if (res.error) return bot.editMessageText(res.error, { chat_id: msg.chat.id, message_id: load.message_id });
  const d = res.data;
  const icon = d.change >= 0 ? '📈' : '📉';
  const txt = `${d.symbol}\nPrice: ${d.price.toFixed(2)} ${d.currency}\n${icon} Change: ${d.change.toFixed(2)} (${d.changePercent.toFixed(2)}%)\nVol: ${d.volume.toLocaleString()}`;
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
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
  t += (dt.trend.pass?'✅':'') + ` Trend: > EMA50(${dt.trend.e50}) & EMA200(${dt.trend.e200})\n`;
  t += (dt.rsi.pass?'✅':'') + ` RSI: ${dt.rsi.val} (48-55)\n`;
  t += (dt.macd.pass?'✅':'') + ` MACD: ${dt.macd.val} (~0)\n\n`;
  t += `Score: ${f.score}/5\n`;
  if (f.passed) t += '\n*** PERFECT BUY SIGNAL ***';
  else if (f.score >= 4) t += '\n* Strong Candidate *';
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
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 800)); // حماية من الحظر
  }
  let t = 'MARKET SCAN\n\n';
  t += `BUY SIGNALS (${buys.length}):\n${buys.join(', ') || 'None'}\n\n`;
  t += `WATCH LIST (${watch.length}):\n${watch.join(', ') || 'None'}`;
  bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/top$/i, async (msg) => {
  const load = await bot.sendMessage(msg.chat.id, 'Calculating top movers...');
  let all = [];
  const symbols = Object.keys(STOCKS);
  for (let i = 0; i < symbols.length; i++) {
    const res = await fetchQuote(symbols[i]);
    if (res.ok) all.push(res.data);
    if (i % 15 === 0) await new Promise(r => setTimeout(r, 600));
  }
  const gainers = all.filter(x => x.change > 0).sort((a, b) => b.changePercent - a.changePercent).slice(0, 5);
  const losers = all.filter(x => x.change < 0).sort((a, b) => a.changePercent - b.changePercent).slice(0, 5);
  const active = all.sort((a, b) => b.volume - a.volume).slice(0, 5);

  const fmt = arr => arr.map(x => `${x.symbol}: ${x.price.toFixed(2)} (${x.changePercent.toFixed(2)}%)`).join('\n');
  let t = ' TOP MOVERS\n\n';
  t += `📈 Gainers:\n${fmt(gainers)}\n\n📉 Losers:\n${fmt(losers)}\n\n🔥 Most Active:\n${active.map(x => `${x.symbol}: ${x.volume.toLocaleString()} vol`).join('\n')}`;
  bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/market$/i, async (msg) => {
  const load = await bot.sendMessage(msg.chat.id, 'Fetching market overview...');
  // EGX30 proxy using top weighted stocks
  const proxies = ['COMI','EGBN','TMGH','PHDC','ETEL','SWDY','ESRS','HRHO','SODIC','MNHD'];
  let scores = [];
  for (const s of proxies) {
    const res = await fetchQuote(s);
    if (res.ok) scores.push(runFilter(res.data).score);
  }
  const avg = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1) : 'N/A';
  const now = new Date();
  const isWeekday = [0,6].includes(now.getDay()) ? false : true; // 0=Sun in JS, but Egypt Sun-Thu
  // Egypt workweek: Sun(0) to Thu(4). Fri(5), Sat(6) closed.
  const isOpen = isWeekday && now.getHours() >= 10 && now.getHours() < 15;
  let t = ` MARKET OVERVIEW\n\n`;
  t += `Status: ${isOpen ? '🟢 Open' : '🔴 Closed'}\n`;
  t += `Technical Score (Avg): ${avg}/5\n`;
  t += `Time: ${now.toLocaleTimeString('en-EG', {timeZone:'Africa/Cairo'})}\n`;
  t += `\nUse /top for movers, /scan for full filter.`;
  bot.editMessageText(t, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/add\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  if (!watchlist.has(msg.chat.id)) watchlist.set(msg.chat.id, []);
  const list = watchlist.get(msg.chat.id);
  if (!list.includes(sym)) { list.push(sym); bot.sendMessage(msg.chat.id, 'Added ' + sym); }
  else bot.sendMessage(msg.chat.id, 'Already exists');
});

bot.onText(/^\/list$/i, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  bot.sendMessage(msg.chat.id, list.length ? 'Watchlist:\n' + list.join('\n') : 'Empty');
});

bot.onText(/^\/(support|resistance)\s+(\w+)\s+([\d.]+)$/i, (msg, match) => {
  const type = match[1], symbol = match[2].toUpperCase(), price = parseFloat(match[3]);
  const cid = msg.chat.id;
  if (!STOCKS[symbol]) return bot.sendMessage(msg.chat.id, 'Symbol not supported');
  if (!srLevels.has(cid)) srLevels.set(cid, {});
  if (!srLevels.get(cid)[symbol]) srLevels.get(cid)[symbol] = { support: [], resistance: [] };
  srLevels.get(cid)[symbol][type === 'support' ? 'support' : 'resistance'].push(price);
  bot.sendMessage(msg.chat.id, `Set ${type} for ${symbol} at ${price}`);
});

bot.onText(/^\/alerts$/i, (msg) => {
  const levels = srLevels.get(msg.chat.id);
  if (!levels) return bot.sendMessage(msg.chat.id, 'No alerts set');
  let t = 'Your Alerts:\n';
  for (const [sym, lvls] of Object.entries(levels)) {
    if (lvls.support.length) t += ` ${sym} Support: ${lvls.support.join(', ')}\n`;
    if (lvls.resistance.length) t += `🔴 ${sym} Resistance: ${lvls.resistance.join(', ')}\n`;
  }
  bot.sendMessage(msg.chat.id, t);
});

// ====== فحص دوري كل 10 دقائق (ذكاء توفير الموارد) ======
setInterval(async () => {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 5=Fri, 6=Sat
  const hour = now.getHours();
  // سوق مصر: أحد-خميس 10:00-14:30
  if ([5,6].includes(day) || hour < 10 || hour >= 15) {
    console.log('Market closed. Skipping periodic check.');
    return;
  }

  console.log('Running periodic checks...');
  for (const [cid, list] of watchlist) {
    for (const sym of list) {
      try {
        const res = await fetchQuote(sym);
        if (res.ok) {
          const f = runFilter(res.data);
          if (f.passed) bot.sendMessage(cid, `🚨 ${sym} hit filter!\nPrice: ${res.data.price.toFixed(2)} | Score: ${f.score}/5`);
        }
      } catch(e) { continue; }
      await new Promise(r => setTimeout(r, 1000)); // تأخير بين الطلبات
    }
  }

  for (const [cid, symbols] of srLevels) {
    for (const [sym, lvls] of Object.entries(symbols)) {
      try {
        const res = await fetchQuote(sym);
        if (!res.ok) continue;
        const p = res.data.price;
        for (const sp of lvls.support) if (Math.abs(p - sp) < 0.1) bot.sendMessage(cid, `🟢 ${sym} touched support ${sp}`);
        for (const rp of lvls.resistance) if (Math.abs(p - rp) < 0.1) bot.sendMessage(cid, `🔴 ${sym} touched resistance ${rp}`);
      } catch(e) { continue; }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}, 600000); // 10 دقائق

console.log('Hegazy Trade Bot v4.0 Stable Started');