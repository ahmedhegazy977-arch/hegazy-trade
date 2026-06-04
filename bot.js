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
      timeout: 10000 
    });
    
    if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
      return null;
    }
    
    const result = data.chart.result[0];
    const quotes = result.indicators.quote[0];
    
    const closes = quotes.close.filter(c => c !== null);
    const volumes = quotes.volume.filter(v => v !== null);
    const opens = quotes.open.filter(o => o !== null);
    
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
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000 
    });
    const $ = cheerio.load(data);
    
    const priceText = $('.stock-price__value').first().text().trim().replace(/,/g, '');
    const price = parseFloat(priceText);
    const volumeText = $('.stock-price__volume').first().text().trim().replace(/,/g, '');
    const volume = parseInt(volumeText) || 0;
    
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
  
  let gains = 0;
  let losses = 0;
  
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
  const histogram = macdLine - signalLine;
  
  return { macdLine, signalLine, histogram };
}

// ==================== تطبيق الفلتر ====================

async function applyFilter(symbol) {
  const historical = await getHistoricalData(symbol);
  const current = await getCurrentPrice(symbol);
  
  if (!historical || !current) {
    return { success: false, message: 'فشل في جلب البيانات' };
  }
  
  const { closes, volumes, opens } = historical;
  const { price, volume } = current;
  
  const smaVolume20 = calculateSMA(volumes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  
  const results = {
    symbol: symbol.toUpperCase(),
    price,
    volume,
    checks: {}
  };
  
  // الشرط 1: الحجم
  const volumeCondition = smaVolume20 && volume >= smaVolume20 * 1.2;
  results.checks.volume = {
    pass: volumeCondition,
    value: volume,
    threshold: smaVolume20 ? Math.round(smaVolume20 * 1.2) : null
  };
  
  // الشرط 2: استقرار السعر
  const lastOpen = opens[opens.length - 1];
  const priceStability = lastOpen && (Math.abs(price - lastOpen) / price < 0.02);
  results.checks.stability = {
    pass: priceStability,
    change: lastOpen ? (Math.abs(price - lastOpen) / price * 100) : null
  };
  
  // الشرط 3: الاتجاه
  const trendCondition = ema50 && ema200 && price > ema50 && price > ema200;
  results.checks.trend = {
    pass: trendCondition,
    price,
    ema50,
    ema200
  };
  
  // الشرط 4: RSI
  const rsiCondition = rsi !== null && rsi >= 48 && rsi <= 55;
  results.checks.rsi = {
    pass: rsiCondition,
    value: rsi
  };
  
  // الشرط 5: MACD
  const macdCondition = macd && Math.abs(macd.histogram) < 0.1;
  results.checks.macd = {
    pass: macdCondition,
    histogram: macd ? macd.histogram : null
  };
  
  results.passed = Object.values(results.checks).every(c => c.pass);
  results.passedCount = Object.values(results.checks).filter(c => c.pass).length;
  results.totalChecks = Object.keys(results.checks).length;
  
  return { success: true, data: results };
}

// ==================== أوامر البوت ====================

bot.onText(/\/ابدأ/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `👋 *أهلاً بك في بوت حجازي للتداول!*\n\n` +
    `📊 *الأوامر المتاحة:*\n\n` +
    `🔍 *فحص سهم:*\n/فحص SYMBOL\n\n` +
    `📋 *قائمة المراقبة:*\n/اضافة SYMBOL\n/قائمة\n/حذف SYMBOL\n\n` +
    ` *فحص الكل:*\n/فحص_الكل\n\n` +
    ` *مثال:*\n/فحص EFID`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/فحص\s+(\w+)/i, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  const loading = await bot.sendMessage(msg.chat.id, `جاري فحص ${symbol}...`);
  
  const result = await applyFilter(symbol);
  
  if (!result.success) {
    bot.editMessageText(result.message, {
      chat_id: msg.chat.id,
      message_id: loading.message_id
    });
    return;
  }
  
  const data = result.data;
  const emoji = data.passed ? '' : '📊';
  
  let message = `${emoji} *نتيجة فحص ${data.symbol}*\n\n`;
  message += ` *السعر الحالي:* ${data.price} جنيه\n`;
  message += `📊 *الحجم:* ${data.volume.toLocaleString()}\n\n`;
  message += `*تفاصيل الفلتر:*\n━━━━━━━━━━━━━━━━\n`;
  
  const volEmoji = data.checks.volume.pass ? '✅' : '❌';
  message += `${volEmoji} *الحجم:* ${data.checks.volume.value.toLocaleString()}`;
  if (data.checks.volume.threshold) {
    message += ` (المطلوب: ${data.checks.volume.threshold.toLocaleString()})`;
  }
  message += '\n';
  
  const stabEmoji = data.checks.stability.pass ? '✅' : '❌';
  message += `${stabEmoji} *استقرار السعر:* ${data.checks.stability.change ? data.checks.stability.change.toFixed(2) + '%' : 'N/A'} (مطلوب < 2%)\n`;
  
  const trendEmoji = data.checks.trend.pass ? '✅' : '❌';
  message += `${trendEmoji} *الاتجاه:* السعر ${data.checks.trend.price} | EMA50 ${data.checks.trend.ema50 ? data.checks.trend.ema50.toFixed(2) : 'N/A'} | EMA200 ${data.checks.trend.ema200 ? data.checks.trend.ema200.toFixed(2) : 'N/A'}\n`;
  
  const rsiEmoji = data.checks.rsi.pass ? '✅' : '❌';
  message += `${rsiEmoji} *RSI:* ${data.checks.rsi.value ? data.checks.rsi.value.toFixed(2) : 'N/A'} (مطلوب 48-55)\n`;
  
  const macdEmoji = data.checks.macd.pass ? '✅' : '❌';
  message += `${macdEmoji} *MACD:* ${data.checks.macd.histogram ? data.checks.macd.histogram.toFixed(4) : 'N/A'} (مطلوب قريب من 0)\n`;
  
  message += `━━━━━━━━━━━━━━━━\n`;
  message += `\n📊 *النتيجة:* ${data.passedCount}/${data.totalChecks} شروط محققة\n`;
  
  if (data.passed) {
    message += `\n🎉 *ممتاز! السهم يحقق كل شروط الفلتر!*`;
  } else {
    message += `\n⚠️ *السهم لا يحقق كل الشروط*`;
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
  
  if (!watchlist.has(chatId)) {
    watchlist.set(chatId, []);
  }
  
  const list = watchlist.get(chatId);
  if (list.includes(symbol)) {
    bot.sendMessage(msg.chat.id, `⚠️ ${symbol} موجود بالفعل في القائمة`);
    return;
  }
  
  list.push(symbol);
  bot.sendMessage(msg.chat.id, `✅ تم إضافة *${symbol}* لقائمة المراقبة`, { parse_mode: 'Markdown' });
});

bot.onText(/\/قائمة/, (msg) => {
  const chatId = msg.chat.id;
  const list = watchlist.get(chatId);
  
  if (!list || list.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 قائمة المراقبة فارغة\n\nاستخدم /اضافة SYMBOL لإضافة سهم');
    return;
  }
  
  let message = '📋 *قائمة المراقبة:*\n\n';
  list.forEach((symbol, index) => {
    message += `${index + 1}. *${symbol}*\n`;
  });
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/حذف\s+(\w+)/i, (msg, match) => {
  const symbol = match[1].toUpperCase();
  const chatId = msg.chat.id;
  const list = watchlist.get(chatId);
  
  if (!list || !list.includes(symbol)) {
    bot.sendMessage(msg.chat.id, `⚠️ ${symbol} غير موجود في القائمة`);
    return;
  }
  
  const index = list.indexOf(symbol);
  list.splice(index, 1);
  bot.sendMessage(msg.chat.id, `✅ تم حذف *${symbol}* من القائمة`, { parse_mode: 'Markdown' });
});

bot.onText(/\/فحص_الكل/, async (msg) => {
  const chatId = msg.chat.id;
  const list = watchlist.get(chatId);
  
  if (!list || list.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 قائمة المراقبة فارغة');
    return;
  }
  
  const loading = await bot.sendMessage(msg.chat.id, `جاري فحص ${list.length} سهم...`);
  
  let results = [];
  for (const symbol of list) {
    const result = await applyFilter(symbol);
    if (result.success) {
      results.push(result.data);
    }
  }
  
  results.sort((a, b) => b.passedCount - a.passedCount);
  
  let message = ' *نتائج الفحص:*\n\n';
  results.forEach((data) => {
    const emoji = data.passed ? '🎉' : (data.passedCount >= 4 ? '✅' : '⚠️');
    message += `${emoji} *${data.symbol}*: ${data.passedCount}/${data.totalChecks}\n`;
    message += `   💰 ${data.price} جنيه\n\n`;
  });
  
  bot.editMessageText(message, {
    chat_id: msg.chat.id,
    message_id: loading.message_id,
    parse_mode: 'Markdown'
  });
});

// فحص دوري كل ساعة
setInterval(async () => {
  console.log('Running periodic check...');
  
  for (const [chatId, list] of watchlist) {
    for (const symbol of list) {
      try {
        const result = await applyFilter(symbol);
        if (result.success && result.data.passed) {
          const data = result.data;
          bot.sendMessage(chatId, 
            `🚨 *تنبيه! ${data.symbol} يحقق شروط الفلتر!*\n\n` +
            `💰 السعر: ${data.price} جنيه\n` +
            `📊 محقق ${data.passedCount}/${data.totalChecks} شروط`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (error) {
        console.error('Periodic check error:', error);
      }
    }
  }
}, 60 * 60 * 1000);

console.log('✅ Hegazy Trade Bot (Arabic) is running...');