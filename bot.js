const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// Storage
const watchlist = new Map();
const srLevels = new Map(); // { chatId: { SYMBOL: { support: [], resistance: [] } } }
const priceAlerts = new Map(); // { chatId: [ {symbol, type, price} ] }
const breakoutLog = new Set(); // Track breakouts to avoid duplicate alerts

// Egyptian Stocks (Yahoo Finance Tickers)
const EGX_STOCKS = {
  'EFID': 'EFID.CA', 'COMI': 'COMI.CA', 'ETEL': 'ETEL.CA',
  'SWDY': 'SWDY.CA', 'HRHO': 'HRHO.CA', 'ESRS': 'ESRS.CA',
  'PHDC': 'PHDC.CA', 'TMGH': 'TMGH.CA', 'EAST': 'EAST.CA',
  'EGBN': 'EGBN.CA', 'OCDI': 'OCDI.CA', 'ISPH': 'ISPH.CA',
  'MNHD': 'MNHD.CA', 'OBEL': 'OBEL.CA', 'SODIC': 'SODIC.CA',
  'FWRY': 'FWRY.CA', 'EKHO': 'EKHO.CA', 'EKZN': 'EKZN.CA',
  'MCDR': 'MCDR.CA', 'AMOC': 'AMOC.CA', 'APPC': 'APPC.CA',
  'SKPC': 'SKPC.CA', 'GBCO': 'GBCO.CA', 'HELI': 'HELI.CA',
  'OLFI': 'OLFI.CA', 'PHCI': 'PHCI.CA', 'RMDA': 'RMDA.CA',
  'TALM': 'TALM.CA', 'TELS': 'TELS.CA', 'UPFD': 'UPFD.CA',
  'WUFA': 'WUFA.CA', 'YRGN': 'YRGN.CA', 'ZOD': 'ZOD.CA'
};

// ==================== TECHNICAL INDICATORS ====================
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
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  },
  
  macd: (closes) => {
    const ema12 = calc.ema(closes, 12);
    const ema26 = calc.ema(closes, 26);
    if (!ema12 || !ema26) return null;
    const macdLine = ema12 - ema26;
    const macdValues = [];
    for (let i = 26; i < closes.length; i++) {
      const e12 = calc.ema(closes.slice(0, i + 1), 12);
      const e26 = calc.ema(closes.slice(0, i + 1), 26);
      if (e12 && e26) macdValues.push(e12 - e26);
    }
    const signalLine = calc.ema(macdValues, 9);
    return { line: macdLine, signal: signalLine, histogram: macdLine - signalLine };
  }
};

// ==================== DATA FETCHING ====================
async function fetchQuote(symbol) {
  const ticker = EGX_STOCKS[symbol.toUpperCase()];
  if (!ticker) return { error: 'Symbol not supported' };

  try {
    // Get 1 year data for indicators + current quote
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 15000
    });

    const result = data.chart?.result?.[0];
    if (!result || !result.meta) return { error: 'No data available' };

    const meta = result.meta;
    const quotes = result.indicators?.quote?.[0];
    
    const closes = quotes?.close?.filter(v => v !== null) || [];
    const volumes = quotes?.volume?.filter(v => v !== null) || [];
    const opens = quotes?.open?.filter(v => v !== null) || [];
    
    const currentPrice = meta.regularMarketPrice || closes[closes.length - 1];
    const prevClose = meta.previousClose || meta.regularMarketPreviousClose || closes[closes.length - 2];
    
    return {
      ok: true,
      data: {
        symbol: symbol.toUpperCase(),
        price: currentPrice,
        change: currentPrice - prevClose,
        changePercent: prevClose ? ((currentPrice - prevClose) / prevClose * 100) : 0,
        currency: meta.currency || 'EGP',
        volume: meta.regularMarketVolume || volumes[volumes.length - 1] || 0,
        high: meta.regularMarketDayHigh,
        low: meta.regularMarketDayLow,
        open: meta.regularMarketDayOpen,
        closes, volumes, opens // For technical analysis
      }
    };
  } catch (e) {
    return { error: 'Connection error: ' + e.message };
  }
}

// ==================== ADVANCED FILTER ====================
function applyFilter(data) {
  const { closes, volumes, opens, price, volume } = data;
  if (closes.length < 200) return { passed: false, reason: 'Insufficient data' };

  const checks = {};
  
  // 1. Volume: >= SMA(20) * 1.2
  const smaVol20 = calc.sma(volumes, 20);
  checks.volume = smaVol20 && volume >= smaVol20 * 1.2;
  
  // 2. Price Stability: |Close-Open|/Close < 2%
  const lastOpen = opens[opens.length - 1];
  const stability = lastOpen ? Math.abs(price - lastOpen) / price : 1;
  checks.stability = stability < 0.02;
  
  // 3. Trend: Price > EMA50 & EMA200
  const ema50 = calc.ema(closes, 50);
  const ema200 = calc.ema(closes, 200);
  checks.trend = ema50 && ema200 && price > ema50 && price > ema200;
  
  // 4. RSI: 48-55 (neutral accumulation zone)
  const rsi = calc.rsi(closes);
  checks.rsi = rsi !== null && rsi >= 48 && rsi <= 55;
  
  // 5. MACD Histogram near zero
  const macd = calc.macd(closes);
  checks.macd = macd && Math.abs(macd.histogram) < 0.1;

  const passed = Object.values(checks).every(v => v);
  const score = Object.values(checks).filter(v => v).length;

  return {
    passed,
    score,
    total: 5,
    details: {
      volume: { pass: checks.volume, value: volume, threshold: smaVol20 ? Math.round(smaVol20 * 1.2) : null },
      stability: { pass: checks.stability, value: (stability * 100).toFixed(2) + '%' },
      trend: { pass: checks.trend, price, ema50: ema50?.toFixed(2), ema200: ema200?.toFixed(2) },
      rsi: { pass: checks.rsi, value: rsi?.toFixed(1) },
      macd: { pass: checks.macd, value: macd?.histogram?.toFixed(3) }
    }
  };
}

// ==================== BREAKOUT DETECTION ====================
function detectBreakout(data) {
  const { closes, price, volume, volumes } = data;
  if (closes.length < 50) return false;
  
  // Simple breakout: price above 20-day high + volume spike
  const recentHigh = Math.max(...closes.slice(-20));
  const avgVol = calc.sma(volumes, 20);
  
  return price > recentHigh && volume >= avgVol * 1.5;
}

// ==================== COMMANDS ====================
bot.onText(/^\/start$/i, (msg) => {
  const text = `🚀 *Hegazy Trade Bot PRO v2.0*\n\n` +
    `📊 *Commands:*\n` +
    \`/price SYMBOL - Live price + indicators\n` +
    \`/filter SYMBOL - Apply advanced accumulation filter\n` +
    \`/scan - Scan all EGX stocks for opportunities\n` +
    \`/breakouts - Find recent breakout candidates\n` +
    \`/support SYMBOL PRICE - Set support alert\n` +
    \`/resistance SYMBOL PRICE - Set resistance alert\n` +
    \`/alerts - View your active alerts\n` +
    \`/add SYMBOL - Add to watchlist\n` +
    \`/list - View watchlist\n\n` +
    `💡 *Example:* \`/filter EFID\``;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /price command
bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, `⏳ Loading ${symbol}...`);
  
  const result = await fetchQuote(symbol);
  if (result.error) {
    return bot.editMessageText(`❌ ${result.error}`, {
      chat_id: msg.chat.id, message_id: load.message_id
    });
  }
  
  const d = result.data;
  const icon = d.change >= 0 ? '📈' : '📉';
  
  const text = `📊 *${d.symbol}*\n` +
    `💰 Price: *${d.price.toFixed(2)}* ${d.currency}\n` +
    `${icon} Change: *${d.change.toFixed(2)}* (${d.changePercent.toFixed(2)}%)\n` +
    `🔓 Open: ${d.open?.toFixed(2) || 'N/A'}\n` +
    `📈 High: ${d.high?.toFixed(2) || 'N/A'} | 📉 Low: ${d.low?.toFixed(2) || 'N/A'}\n` +
    `📊 Volume: ${d.volume.toLocaleString()}\n` +
    `🕐 ${new Date().toISOString().split('T')[0]}`;
  
  bot.editMessageText(text, {
    chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'Markdown'
  });
});

// /filter command - Advanced accumulation filter
bot.onText(/^\/filter\s+(\w+)$/i, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, `🔍 Analyzing ${symbol}...`);
  
  const result = await fetchQuote(symbol);
  if (result.error) {
    return bot.editMessageText(`❌ ${result.error}`, {
      chat_id: msg.chat.id, message_id: load.message_id
    });
  }
  
  const filterResult = applyFilter(result.data);
  const d = result.data;
  
  let text = `🎯 *${symbol} - Accumulation Filter*\n\n`;
  text += \`💰 Price: ${d.price.toFixed(2)} ${d.currency}\n\n\`;
  
  const c = filterResult.details;
  text += \`✅ Volume: ${c.volume.value.toLocaleString()} ${c.volume.threshold ? '(≥' + c.volume.threshold.toLocaleString() + ')' : ''}\n\`;
  text += \`✅ Stability: ${c.stability.value} (<2%)\n\`;
  text += \`✅ Trend: Above EMA50(${c.trend.ema50}) & EMA200(${c.trend.ema200})\n\`;
  text += \`✅ RSI: ${c.rsi.value} (48-55 zone)\n\`;
  text += \`✅ MACD: ${c.macd.value} (near 0)\n\n\`;
  
  text += \`📊 Score: *${filterResult.score}/5*\n\`;
  
  if (filterResult.passed) {
    text += `\n🚀 *EXCELLENT! Stock meets ALL accumulation criteria!*`;
  } else if (filterResult.score >= 4) {
    text += `\n✅ *Strong candidate - Watch closely!*`;
  } else {
    text += `\n⏳ *Not in accumulation zone yet*`;
  }
  
  bot.editMessageText(text, {
    chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'Markdown'
  });
});

// /scan command - Scan all EGX stocks
bot.onText(/^\/scan$/i, async (msg) => {
  const load = await bot.sendMessage(msg.chat.id, `🌍 Scanning ${Object.keys(EGX_STOCKS).length} EGX stocks... (may take 60s)`);
  
  let buys = [], breakouts = [], watch = [];
  
  for (const [sym, ticker] of Object.entries(EGX_STOCKS)) {
    try {
      const result = await fetchQuote(sym);
      if (!result.ok) continue;
      
      const filterResult = applyFilter(result.data);
      const isBreakout = detectBreakout(result.data) && !breakoutLog.has(sym);
      
      if (filterResult.passed) {
        buys.push({ sym, price: result.data.price, score: filterResult.score });
      } else if (filterResult.score >= 4) {
        watch.push({ sym, price: result.data.price, score: filterResult.score });
      }
      if (isBreakout) {
        breakouts.push({ sym, price: result.data.price });
        breakoutLog.add(sym);
      }
    } catch (e) { continue; }
  }
  
  let text = `🌍 *EGX Market Scan Report*\n\n`;
  text += \`🎯 *Accumulation Candidates (${buys.length}):*\n\`;
  text += buys.length ? buys.map(s => \`• *${s.sym}* ${s.price.toFixed(2)} EGP (Score: ${s.score}/5)\`).join('\n') : 'None found';
  text += `\n\n🚀 *Recent Breakouts (${breakouts.length}):*\n\`;
  text += breakouts.length ? breakouts.map(s => \`• *${s.sym}* ${s.price.toFixed(2)} EGP\`).join('\n') : 'None detected';
  text += `\n\n⚪ *Watch List (${watch.length}):*\n\`;
  text += watch.length ? watch.map(s => \`• *${s.sym}* ${s.price.toFixed(2)} EGP (Score: ${s.score}/5)\`).join('\n') : 'None';
  
  bot.editMessageText(text, {
    chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'Markdown'
  });
});

// /breakouts command
bot.onText(/^\/breakouts$/i, async (msg) => {
  const load = await bot.sendMessage(msg.chat.id, `🚀 Finding breakouts...`);
  
  let results = [];
  for (const sym of Object.keys(EGX_STOCKS)) {
    try {
      const result = await fetchQuote(sym);
      if (result.ok && detectBreakout(result.data) && !breakoutLog.has(sym)) {
        results.push({ sym, price: result.data.price });
        breakoutLog.add(sym);
      }
    } catch (e) { continue; }
  }
  
  if (results.length === 0) {
    return bot.editMessageText('📉 No clear breakouts detected right now.', {
      chat_id: msg.chat.id, message_id: load.message_id
    });
  }
  
  const text = `🚀 *Breakout Candidates*\n\n` +
    results.map(r => \`• *${r.sym}* - ${r.price.toFixed(2)} EGP\n  High volume + price above 20-day high\`).join('\n');
  
  bot.editMessageText(text, {
    chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'Markdown'
  });
});

// Support/Resistance commands
bot.onText(/^\/(support|resistance)\s+(\w+)\s+([\d.]+)$/i, (msg, match) => {
  const type = match[1], symbol = match[2].toUpperCase(), price = parseFloat(match[3]);
  const chatId = msg.chat.id;
  
  if (!EGX_STOCKS[symbol]) {
    return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
  }
  
  if (!srLevels.has(chatId)) srLevels.set(chatId, {});
  if (!srLevels.get(chatId)[symbol]) {
    srLevels.get(chatId)[symbol] = { support: [], resistance: [] };
  }
  
  srLevels.get(chatId)[symbol][type === 'support' ? 'support' : 'resistance'].push(price);
  
  const icon = type === 'support' ? '🟢' : '🔴';
  bot.sendMessage(msg.chat.id, \`✅ Set ${icon} ${type} for ${symbol} at ${price} EGP\`);
});

// /alerts command
bot.onText(/^\/alerts$/i, (msg) => {
  const chatId = msg.chat.id;
  const levels = srLevels.get(chatId);
  const alerts = priceAlerts.get(chatId) || [];
  
  if (!levels && alerts.length === 0) {
    return bot.sendMessage(msg.chat.id, '📭 No active alerts');
  }
  
  let text = '🔔 *Your Alerts*\n\n';
  
  // Support/Resistance
  if (levels) {
    for (const [sym, lvls] of Object.entries(levels)) {
      if (lvls.support.length) {
        text += \`🟢 *${sym}* Support: ${lvls.support.join(', ')}\n\`;
      }
      if (lvls.resistance.length) {
        text += \`🔴 *${sym}* Resistance: ${lvls.resistance.join(', ')}\n\`;
      }
    }
  }
  
  // Price alerts
  if (alerts.length) {
    text += `\n📊 Price Alerts:\n` +
      alerts.map(a => \`• ${a.symbol} ${a.type} ${a.price} EGP\`).join('\n');
  }
  
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /add and /list commands
bot.onText(/^\/add\s+(\w+)$/i, (msg, match) => {
  const symbol = match[1].toUpperCase();
  const chatId = msg.chat.id;
  
  if (!EGX_STOCKS[symbol]) {
    return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
  }
  
  if (!watchlist.has(chatId)) watchlist.set(chatId, []);
  const list = watchlist.get(chatId);
  
  if (!list.includes(symbol)) {
    list.push(symbol);
    bot.sendMessage(msg.chat.id, \`✅ Added ${symbol} to watchlist\`);
  } else {
    bot.sendMessage(msg.chat.id, \`⚠️ ${symbol} already in watchlist\`);
  }
});

bot.onText(/^\/list$/i, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  if (list.length === 0) {
    return bot.sendMessage(msg.chat.id, '📭 Watchlist is empty');
  }
  const text = '👀 *Your Watchlist*\n' +
    list.map((s, i) => \`${i + 1}. *${s}*\`).join('\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// ==================== PERIODIC CHECKS (Every Hour) ====================
setInterval(async () => {
  console.log('🔄 Running periodic checks...');
  
  // 1. Check watchlist for filter passes
  for (const [chatId, list] of watchlist) {
    for (const symbol of list) {
      try {
        const result = await fetchQuote(symbol);
        if (result.ok) {
          const filterResult = applyFilter(result.data);
          if (filterResult.passed) {
            bot.sendMessage(chatId,
              \`🚨 *${symbol} hit accumulation filter!*\n💰 ${result.data.price.toFixed(2)} EGP\nScore: ${filterResult.score}/5\`,
              { parse_mode: 'Markdown' }
            );
          }
        }
      } catch (e) { continue; }
    }
  }
  
  // 2. Check support/resistance levels
  for (const [chatId, symbols] of srLevels) {
    for (const [symbol, levels] of Object.entries(symbols)) {
      try {
        const result = await fetchQuote(symbol);
        if (!result.ok) continue;
        const price = result.data.price;
        
        for (const sp of levels.support) {
          if (Math.abs(price - sp) < 0.1) {
            bot.sendMessage(chatId, \`🟢 *${symbol} touched support!*\n💰 ${price.toFixed(2)} ≈ ${sp} EGP\`, { parse_mode: 'Markdown' });
          }
        }
        for (const rp of levels.resistance) {
          if (Math.abs(price - rp) < 0.1) {
            bot.sendMessage(chatId, \`🔴 *${symbol} touched resistance!*\n💰 ${price.toFixed(2)} ≈ ${rp} EGP\`, { parse_mode: 'Markdown' });
          }
        }
      } catch (e) { continue; }
    }
  }
  
}, 3600000); // Every hour

console.log('✅ Hegazy Trade Bot PRO v2.0 Started - All Systems Active');