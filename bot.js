const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// تخزين البيانات
const watchlist = new Map();
const alerts = new Map();

// ==================== جلب البيانات ====================

async function getHistoricalData(symbol) {
  try {
    const ticker = `${symbol.toUpperCase()}.CA`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d`;
    
    const { data } = await axios.get(url, { 
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000 
    });
    
    if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
      return null;
    }
    
    const result = data.chart.result[0];
    const quotes = result.indicators.quote[0];
    
    const closes = quotes.close ? quotes.close.filter(c => c !== null) : [];
    const volumes = quotes.volume ? quotes.volume.filter(v => v !== null) : [];
    const opens = quotes.open ? quotes.open.filter(o => o !== null) : [];
    
    if (closes.length < 50) return null;
    
    return { closes, volumes, opens };
  } catch (error) {
    console.error('Yahoo Finance Error:', error.message);
    return null;
  }
}

async function getCurrentPrice(symbol) {
  try {
    const url = `https://www.mubasher.info/markets/Egypt/stocks/${symbol.toUpperCase()}`;
    const { data } = await axios.get(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 15000 
    });
    const $ = cheerio.load(data);
    
    let priceText = $('.stock-price__value').first().text().trim().replace(/,/g, '');
    const price = parseFloat(priceText);
    
    let volumeText = $('.stock-price__volume').first().text().trim().replace(/,/g, '');
    const volume = parseInt(volumeText) || 0;
    
    if (isNaN(price)) return null;
    
    return { price, volume };
  } catch (error) {
    console.error('Mubasher Error:', error.message);
    return null;
  }
}

// ==================== الحسابات الفنية ====================

function calculateSMA(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  return slice.reduce((sum, val) => sum + val, 0) / period;
}

function calculateEMA(data, period) {
  if (data.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  
  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  
  let gains = 0, losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
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
}

function calculateMACD(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  if (ema12 === null || ema26 === null) return null;
  
  const macdLine = ema12 - ema26;
  
  const macdValues = [];
  for (let i = 26; i < closes.length; i++) {
    const e12 = calculateEMA(closes.slice(0, i + 1), 12);
    const e26 = calculateEMA(closes.slice(0, i + 1), 26);
    if (e12 && e26) macdValues.push(e12 - e26);
  }
  
  const signalLine = calculateEMA(macdValues, 9);
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

// ==================== تطبيق الفلتر ====================

async function applyFilter(symbol) {
  const [historical, current] = await Promise.all([
    getHistoricalData(symbol),
    getCurrentPrice(symbol)
  ]);
  
  if (!current) {
    return { success: false, message: `❌ فشل في جلب بيانات ${symbol}` };
  }
  
  const { price, volume } = current;
  const result = { symbol: symbol.toUpperCase(), price, volume, checks: {} };
  
  if (!historical) {
    result.message = `⚠️ ${symbol}: السعر ${price} جنيه (البيانات التاريخية غير متاحة)`;
    return { success: true, data: result, partial: true };
  }
  
  const { closes, volumes, opens } = historical;
  
  const smaVolume20 = calculateSMA(volumes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  
  // الشرط 1: الحجم
  result.checks.volume = {
    pass: smaVolume20 && volume >= smaVolume20 * 1.2,
    value: volume,
    threshold: smaVolume20 ? Math.round(smaVolume20 * 1.2) : null
  };
  
  // الشرط 2: استقرار السعر
  const lastOpen = opens[opens.length - 1];
  const stability = lastOpen ? Math.abs(price - lastOpen) / price : null;
  result.checks.stability = {
    pass: stability !== null && stability < 0.02,
    change: stability ? (stability * 100) : null
  };
  
  // الشرط 3: الاتجاه
  result.checks.trend = {
    pass: ema50 && ema200 && price > ema50 && price > ema200,
    price, ema50, ema200
  };
  
  // الشرط 4: RSI
  result.checks.rsi = {
    pass: rsi !== null && rsi >= 48 && rsi <= 55,
    value: rsi
  };
  
  // الشرط 5: MACD
  result.checks.macd = {
    pass: macd && Math.abs(macd.histogram) < 0.1,
    histogram: macd ? macd.histogram : null
  };
  
  result.passed = Object.values(result.checks).every(c => c.pass);
  result.passedCount = Object.values(result.checks).filter(c => c.pass).length;
  result.totalChecks = Object.keys(result.checks).length;
  
  return { success: true, data: result };
}

// ==================== أوامر البوت ====================

bot.onText(/\/ابدأ/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `👋 *أهلاً بك في بوت حجازي للتداول!*\n\n` +
    `📊 *الأوامر المتاحة:*\n\n` +
    `🔍 *فحص سهم بالفلتر:*\n/فحص SYMBOL\n\n` +
    `📋 *قائمة المراقبة:*\n/اضافة SYMBOL\n/قائمة\n/حذف SYMBOL\n/فحص_الكل\n\n` +
    `🔔 *تنبيهات سعر:*\n/تنبيه SYMBOL فوق سعر\n/تنبيه SYMBOL تحت سعر\n/تنبيهات\n\n` +
    `💡 *مثال:*\n/فحص EFID`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/فحص\s+(\w+)/i, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  const loading = await bot.sendMessage(msg.chat.id, `🔍 جاري فحص ${symbol}...`);
  
  const result = await applyFilter(symbol);
  
  if (!result.success) {
    bot.editMessageText(result.message, {
      chat_id: msg.chat.id,
      message_id: loading.message_id
    });
    return;
  }
  
  const data = result.data;
  
  if (result.partial) {
    bot.editMessageText(data.message, {
      chat_id: msg.chat.id,
      message_id: loading.message_id,
      parse_mode: 'Markdown'
    });
    return;
  }
  
  const emoji = data.passed ? '🎉' : '📊';
  let message = `${emoji} *نتيجة فحص ${data.symbol}*\n\n`;
  message += `💰 *السعر:* ${data.price} جنيه\n`;
  message += `📊 *الحجم:* ${data.volume.toLocaleString()}\n\n`;
  message += `*الفلتر المتقدم:*\n━━━━━━━━━━\n`;
  
  const v = data.checks.volume;
  message += `${v.pass ? '✅' : '❌'} *الحجم:* ${v.value.toLocaleString()}`;
  if (v.threshold) message += ` (المطلوب: ${v.threshold.toLocaleString()})`;
  message += '\n';
  
  const s = data.checks.stability;
  message += `${s.pass ? '✅' : '❌'} *استقرار السعر:* ${s.change ? s.change.toFixed(2) + '%' : 'N/A'} (< 2%)\n`;
  
  const t = data.checks.trend;
  message += `${t.pass ? '✅' : '❌'} *الاتجاه:* فوق EMA50 (${t.ema50?.toFixed(2)}) و EMA200 (${t.ema200?.toFixed(2)})\n`;
  
  const r = data.checks.rsi;
  message += `${r.pass ? '✅' : '❌'} *RSI:* ${r.value?.toFixed(2)} (48-55)\n`;
  
  const m = data.checks.macd;
  message += `${m.pass ? '✅' : '❌'} *MACD:* ${m.histogram?.toFixed(4)} (قريب من 0)\n`;
  
  message += `━━━━━━━━━━\n`;
  message += `📊 *النتيجة:* ${data.passedCount}/${data.totalChecks}\n`;
  
  if (data.passed) {
    message += `\n🎉 *ممتاز! السهم يحقق كل الشروط!*`;
  }
  
  bot.editMessageText(message, {
    chat_id: msg.chat.id,
    message_id: loading.message_id,
    parse_mode: 'Markdown'
  });
});

bot.onText(/\/اضافة\s+(\w+)/i, (msg, match) => {
  const symbol = match[1].toUpperCase();
  const chatId = msg.chat.id;
  
  if (!watchlist.has(chatId)) watchlist.set(chatId, []);
  const list = watchlist.get(chatId);
  
  if (list.includes(symbol)) {
    bot.sendMessage(msg.chat.id, `⚠️ ${symbol} موجود بالفعل`);
    return;
  }
  
  list.push(symbol);
  bot.sendMessage(msg.chat.id, `✅ أضيف *${symbol}* للقائمة`, { parse_mode: 'Markdown' });
});

bot.onText(/\/قائمة/, (msg) => {
  const list = watchlist.get(msg.chat.id);
  
  if (!list || list.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 القائمة فارغة');
    return;
  }
  
  let message = '📋 *قائمة المراقبة:*\n\n';
  list.forEach((s, i) => message += `${i + 1}. *${s}*\n`);
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/حذف\s+(\w+)/i, (msg, match) => {
  const symbol = match[1].toUpperCase();
  const list = watchlist.get(msg.chat.id);
  
  if (!list || !list.includes(symbol)) {
    bot.sendMessage(msg.chat.id, `⚠️ ${symbol} مش موجود`);
    return;
  }
  
  list.splice(list.indexOf(symbol), 1);
  bot.sendMessage(msg.chat.id, `✅ اتحذف *${symbol}*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/فحص_الكل/, async (msg) => {
  const list = watchlist.get(msg.chat.id);
  
  if (!list || list.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 القائمة فارغة');
    return;
  }
  
  const loading = await bot.sendMessage(msg.chat.id, `🔍 بفحص ${list.length} سهم...`);
  
  let results = [];
  for (const symbol of list) {
    const r = await applyFilter(symbol);
    if (r.success && r.data) results.push(r.data);
  }
  
  results.sort((a, b) => (b.passedCount || 0) - (a.passedCount || 0));
  
  let message = '📊 *النتائج:*\n\n';
  results.forEach(d => {
    const emoji = d.passed ? '🎉' : (d.passedCount >= 4 ? '✅' : '⚠️');
    message += `${emoji} *${d.symbol}*: ${d.passedCount || 0}/${d.totalChecks || 0} - ${d.price} جنيه\n`;
  });
  
  bot.editMessageText(message, {
    chat_id: msg.chat.id,
    message_id: loading.message_id,
    parse_mode: 'Markdown'
  });
});

bot.onText(/\/تنبيه\s+(\w+)\s+(فوق|تحت)\s+([\d.]+)/i, (msg, match) => {
  const [_, symbol, type, price] = match;
  const chatId = msg.chat.id;
  
  if (!alerts.has(chatId)) alerts.set(chatId, []);
  alerts.get(chatId).push({ symbol: symbol.toUpperCase(), type, price: parseFloat(price) });
  
  bot.sendMessage(msg.chat.id, 
    `✅ *تنبيه:*\n${symbol.toUpperCase()} ${type} ${price} جنيه`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/تنبيهات/, (msg) => {
  const list = alerts.get(msg.chat.id);
  
  if (!list || list.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 مفيش تنبيهات');
    return;
  }
  
  let message = '🔔 *التنبيهات:*\n\n';
  list.forEach((a, i) => {
    message += `${i + 1}. *${a.symbol}* ${a.type} ${a.price}\n`;
  });
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// فحص دوري
setInterval(async () => {
  for (const [chatId, list] of watchlist) {
    for (const symbol of list) {
      const r = await applyFilter(symbol);
      if (r.success && r.data && r.data.passed) {
        bot.sendMessage(chatId, 
          `🚨 *${r.data.symbol} حقق الفلتر!*\n💰 ${r.data.price} جنيه`,
          { parse_mode: 'Markdown' }
        );
      }
    }
  }
}, 60 * 60 * 1000);

console.log('✅ Hegazy Trade Bot Started');