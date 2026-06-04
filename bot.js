const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// تخزين البيانات
const watchlist = new Map(); // قائمة المراقبة
const alerts = new Map(); // التنبيهات

// ==================== دوال جلب البيانات ====================

// جلب البيانات التاريخية من Yahoo Finance
async function getHistoricalData(symbol) {
  try {
    const ticker = `${symbol.toUpperCase()}.CA`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d`;
    const { data } = await axios.get(url, { timeout: 10000 });
    
    if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
      return null;
    }
    
    const result = data.chart.result[0];
    const quotes = result.indicators.quote[0];
    const timestamps = result.timestamp;
    
    const closes = quotes.close.filter(c => c !== null);
    const volumes = quotes.volume.filter(v => v !== null);
    const opens = quotes.open.filter(o => o !== null);
    const highs = quotes.high.filter(h => h !== null);
    const lows = quotes.low.filter(l => l !== null);
    
    return {
      closes,
      volumes,
      opens,
      highs,
      lows,
      timestamps
    };
  } catch (error) {
    console.error('Yahoo Finance Error:', error.message);
    return null;
  }
}

// جلب السعر اللحظي من Mubasher
async function getCurrentPrice(symbol) {
  try {
    const url = `https://www.mubasher.info/markets/Egypt/stocks/${symbol.toUpperCase()}`;
    const { data } = await axios.get(url, { 
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000 
    });
    const $ = cheerio.load(data);
    
    const price = parseFloat($('.stock-price__value').first().text().trim().replace(/,/g, ''));
    const volume = parseInt($('.stock-price__volume').first().text().trim().replace(/,/g, ''));
    
    return { price, volume };
  } catch (error) {
    console.error('Mubasher Error:', error.message);
    return null;
  }
}

// ==================== دوال الحسابات الفنية ====================

// حساب المتوسط المتحرك البسيط SMA
function calculateSMA(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  return slice.reduce((sum, val) => sum + val, 0) / period;
}

// حساب المتوسط المتحرك الأسي EMA
function calculateEMA(data, period) {
  if (data.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  
  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }
  return ema;
}

// حساب مؤشر القوة النسبية RSI
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

// حساب MACD
function calculateMACD(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  if (ema12 === null || ema26 === null) return null;
  
  const macdLine = ema12 - ema26;
  
  // حساب خط الإشارة (EMA 9 لـ MACD)
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
  // 1. جلب البيانات
  const historical = await getHistoricalData(symbol);
  const current = await getCurrentPrice(symbol);
  
  if (!historical || !current) {
    return { success: false, message: '❌ فشل في جلب البيانات' };
  }
  
  const { closes, volumes, opens } = historical;
  const { price, volume } = current;
  
  // 2. حساب المؤشرات
  const smaVolume20 = calculateSMA(volumes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  
  // 3. تطبيق شروط الفلتر
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
  const priceStability = Math.abs(price - lastOpen) / price < 0.02;
  results.checks.stability = {
    pass: priceStability,
    change: Math.abs(price - lastOpen) / price * 100
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
  const rsiCondition = rsi >= 48 && rsi <= 55;
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
  
  // النتيجة النهائية
  results.passed = Object.values(results.checks).every(c => c.pass);
  results.passedCount = Object.values(results.checks).filter(c => c.pass).length;
  results.totalChecks = Object.keys(results.checks).length;
  
  return { success: true, data: results };
}

// ==================== أوامر البوت ====================

// أمر /ابدأ
bot.onText(/\/ابدأ/, (msg) => {
  bot.sendMessage(msg.chat.id, `👋 *أهلاً بك في بوت حجازي للتداول!*

📊 *الأوامر المتاحة:*

🔍 *فحص سهم:*
/فحص SYMBOL - فحص سهم واحد (مثال: /فحص EFID)

📋 *قائمة المراقبة:*
/اضافة SYMBOL - إضافة سهم للقائمة
/قائمة - عرض الأسهم المضافة
/حذف SYMBOL - حذف سهم من القائمة

🔔 *التنبيهات:*
/تنبيه SYMBOL فوق سعر - تنبيه عند تجاوز سعر
/تنبيه SYMBOL تحت سعر - تنبيه عند النزول تحت سعر
/تنبيهات - عرض التنبيهات النشطة

📈 *الفحص التلقائي:*
/فحص_الكل - فحص كل الأسهم في القائمة

💡 *مثال:*
/فحص EFID`, { parse_mode: 'Markdown' });
});

// أمر /فحص
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
  const emoji = data.passed ? '✅' : '';
  
  let message = `${emoji} *نتيجة فحص ${data.symbol}*\n\n`;
  message += `💰 *السعر الحالي:* ${data.price} جنيه\n`;
  message += `📊 *الحجم:* ${data.volume.toLocaleString()}\n\n`;
  
  message += `*تفاصيل الفلتر:*\n`;
  message += `━━━━━━━━━━━━━━━━\n`;
  
  // الحجم
  const volEmoji = data.checks.volume.pass ? '✅' : '❌';
  message += `${volEmoji} *الحجم:* ${data.checks.volume.value.toLocaleString()}`;
  if (data.checks.volume.threshold) {
    message += ` (المطلوب: ${data.checks.volume.threshold.toLocaleString()})`;
  }
  message += '\n';
  
  // الاستقرار
  const stabEmoji = data.checks.stability.pass ? '✅' : '❌';
  message += `${stabEmoji} *استقرار السعر:* ${data.checks.stability.change.toFixed(2)}% (مطلوب < 2%)\n`;
  
  // الاتجاه
  const trendEmoji = data.checks.trend.pass ? '✅' : '❌';
  message += `${trendEmoji} *الاتجاه:* السعر ${data.checks.trend.price} | EMA50 ${data.checks.trend.ema50?.toFixed(2)} | EMA200 ${data.checks.trend.ema200?.toFixed(2)}\n`;
  
  // RSI
  const rsiEmoji = data.checks.rsi.pass ? '✅' : '❌';
  message += `${rsiEmoji} *RSI:* ${data.checks.rsi.value?.toFixed(2)} (مطلوب 48-55)\n`;
  
  // MACD
  const macdEmoji = data.checks.macd.pass ? '✅' : '❌';
  message += `${macdEmoji} *MACD:* ${data.checks.macd.histogram?.toFixed(4)} (مطلوب قريب من 0)\n`;
  
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

// أمر /اضافة
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

// أمر /قائمة
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

// أمر /حذف
bot.onText(/\/حذف\s+(\w+)/i, (msg, match) => {
  const symbol = match[1].toUpperCase();
  const chatId = msg.chat.id;
  const list = watchlist.get(chatId);
  
  if (!list || !list.includes(symbol)) {
    bot.sendMessage(msg.chat.id, ` ${symbol} غير موجود في القائمة`);
    return;
  }
  
  const index = list.indexOf(symbol);
  list.splice(index, 1);
  bot.sendMessage(msg.chat.id, `✅ تم حذف *${symbol}* من القائمة`, { parse_mode: 'Markdown' });
});

// أمر /فحص_الكل
bot.onText(/\/فحص_الكل/, async (msg) => {
  const chatId = msg.chat.id;
  const list = watchlist.get(chatId);
  
  if (!list || list.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 قائمة المراقبة فارغة');
    return;
  }
  
  const loading = await bot.sendMessage(msg.chat.id, `🔍 جاري فحص ${list.length} سهم...`);
  
  let results = [];
  for (const symbol of list) {
    const result = await applyFilter(symbol);
    if (result.success) {
      results.push(result.data);
    }
  }
  
  // ترتيب حسب عدد الشروط المحققة
  results.sort((a, b) => b.passedCount - a.passedCount);
  
  let message = '📊 *نتائج الفحص:*\n\n';
  results.forEach((data, index) => {
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

// أمر /تنبيه
bot.onText(/\/تنبيه\s+(\w+)\s+(فوق|تحت)\s+([\d.]+)/i, (msg, match) => {
  const symbol = match[1].toUpperCase();
  const type = match[2];
  const price = parseFloat(match[3]);
  const chatId = msg.chat.id;
  
  if (!alerts.has(chatId)) {
    alerts.set(chatId, []);
  }
  
  alerts.get(chatId).push({ symbol, type, price });
  
  bot.sendMessage(msg.chat.id, 
    `✅ *تم إضافة التنبيه:*\n\n` +
    `📊 السهم: *${symbol}*\n` +
    ` السعر: *${price}* جنيه\n` +
    `📈 النوع: ${type}\n\n` +
    `_هنبعتلك تنبيه لما السعر يحقق الشرط!_`,
    { parse_mode: 'Markdown' }
  );
});

// أمر /تنبيهات
bot.onText(/\/تنبيهات/, (msg) => {
  const chatId = msg.chat.id;
  const userAlerts = alerts.get(chatId);
  
  if (!userAlerts || userAlerts.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 مفيش تنبيهات نشطة');
    return;
  }
  
  let message = ' *التنبيهات النشطة:*\n\n';
  userAlerts.forEach((alert, index) => {
    message += `${index + 1}. *${alert.symbol}* - ${alert.type} *${alert.price}* جنيه\n`;
  });
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// فحص دوري كل ساعة
setInterval(async () => {
  console.log('Running periodic check...');
  
  for (const [chatId, list] of watchlist) {
    for (const symbol of list) {
      const result = await applyFilter(symbol);
      if (result.success && result.data.passed) {
        const data = result.data;
        bot.sendMessage(chatId, 
          ` *تنبيه! ${data.symbol} يحقق شروط الفلتر!*\n\n` +
          `💰 السعر: ${data.price} جنيه\n` +
          `📊 محقق ${data.passedCount}/${data.totalChecks} شروط`,
          { parse_mode: 'Markdown' }
        );
      }
    }
  }
}, 60 * 60 * 1000); // كل ساعة

console.log('✅ Hegazy Trade Bot (Arabic) is running...');