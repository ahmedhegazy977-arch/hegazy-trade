const TelegramBot = require('node-telegram-bot-api');
const yahooFinance = require('yahoo-finance2').default;
const { RSI, EMA } = require('technicalindicators');

// التوكن: من Railway أو محلي للتجربة
const TOKEN = process.env.TOKEN || '8372311269:AAHYGU-Bu1VnteJwpTUXkNwSMmcDNoUEfcg';
const bot = new TelegramBot(TOKEN, { polling: true });

// قائمة الأسهم
const WATCHLIST = ['COMI', 'FWRY', 'HRHO', 'ESRS', 'AMOC', 'EFID', 'ETEL', 'PHDC', 'TMGH', 'SODIC'];

console.log('🚀 Hegazy Trade Bot Started...');

// ==================== جلب السعر من مباشر (Scraping) ====================
async function fetchMubasherPrice(symbol) {
  try {
    const url = `https://www.mubasher.info/markets/EGX/stocks/${symbol.toUpperCase()}`;
    const { data: html } = await require('axios').get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "ar-EG,ar;q=0.9"
      },
      timeout: 10000
    });
    
    const match = html.match(/data-qa="last-price"[^>]*>([\d,]+\.\d+)/);
    if (match) return parseFloat(match[1].replace(/,/g, ''));
    return null;
  } catch (e) {
    return null;
  }
}

// ==================== تحليل السهم (محمي بأخطاء فردية) ====================
async function analyzeStock(symbol) {
  try {
    // 1. السعر من مباشر
    let price = await fetchMubasherPrice(symbol);
    const source = price ? 'Mubasher' : 'Yahoo';
    
    // 2. البيانات التاريخية من ياهو
    const history = await yahooFinance.chart(`${symbol}.CA`, {
      period1: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000),
      interval: '1d'
    });
    
    const closes = history.quotes.map(q => q.close).filter(v => v != null);
    if (closes.length < 50) throw new Error('Insufficient data');
    
    // 3. لو مباشر فشل، نستخدم آخر سعر من ياهو
    if (!price) price = closes[closes.length - 1];
    
    // 4. المؤشرات
    const rsiValues = RSI.calculate({ period: 14, values: closes });
    const ema50Values = EMA.calculate({ period: 50, values: closes });
    const currentRsi = rsiValues[rsiValues.length - 1];
    const currentEma50 = ema50Values[ema50Values.length - 1];
    
    // 5. الدعم والمقاومة (آخر 20 يوم)
    const recent = closes.slice(-20);
    const support = Math.min(...recent);
    const resistance = Math.max(...recent);
    
    // 6. الفلتر البسيط
    let signal = null;
    if (price >= resistance * 0.99 && currentRsi < 70) {
      signal = "🚀 اختراق مقاومة";
    } else if (price <= support * 1.03 && currentRsi < 40) {
      signal = "🛡️ ارتداد من دعم";
    }
    
    return {
      symbol,
      price: price.toFixed(2),
      rsi: currentRsi?.toFixed(1) || 'N/A',
      ema50: currentEma50?.toFixed(2) || 'N/A',
      support: support.toFixed(2),
      resistance: resistance.toFixed(2),
      signal,
      source
    };
  } catch (err) {
    console.error(`❌ ${symbol} error: ${err.message}`);
    return { symbol, error: err.message };
  }
}

// ==================== الأوامر ====================

// 1. /start
bot.onText(/^\/start$/i, (msg) => {
  bot.sendMessage(msg.chat.id, 
    '🤖 *Hegazy Trade Bot*\n\n' +
    'الأوامر المتاحة:\n' +
    '/scan - فحص كل الأسهم في القائمة\n' +
    '/price SYMBOL - سعر سهم معين (مثال: /price COMI)\n' +
    '/list - عرض الأسهم المدعومة', 
    { parse_mode: 'Markdown' }
  );
});

// 2. /list
bot.onText(/^\/list$/i, (msg) => {
  bot.sendMessage(msg.chat.id, `✅ الأسهم المدعومة:\n${WATCHLIST.join(', ')}`);
});

// 3. /price SYMBOL
bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  if (!WATCHLIST.includes(symbol)) {
    return bot.sendMessage(msg.chat.id, `❌ ${symbol} غير مدعوم. استخدم /list`);
  }
  
  const load = await bot.sendMessage(msg.chat.id, '⏳ جاري الجلب...');
  const result = await analyzeStock(symbol);
  
  if (result.error) {
    return bot.editMessageText(`❌ خطأ: ${result.error}`, {
      chat_id: msg.chat.id, message_id: load.message_id
    });
  }
  
  let txt = `📊 *${result.symbol}*\n`;
  txt += `💰 السعر: ${result.price} EGP\n`;
  txt += `📡 المصدر: ${result.source}\n`;
  txt += `📈 RSI: ${result.rsi} | EMA50: ${result.ema50}\n`;
  txt += `🔻 الدعم: ${result.support} | 🔺 المقاومة: ${result.resistance}`;
  
  bot.editMessageText(txt, {
    chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'Markdown'
  });
});

// 4. /scan (محمي بـ Promise.allSettled عشان سهم واحد ما يوقفش الكل)
bot.onText(/^\/scan$/i, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '⏳ جاري فحص السوق... (15-20 ثانية)');
  
  // نستخدم allSettled عشان كل سهم يتحل بغض النظر عن التاني
  const promises = WATCHLIST.map(sym => analyzeStock(sym));
  const results = await Promise.allSettled(promises);
  
  const successes = results
    .filter(r => r.status === 'fulfilled' && r.value && !r.value.error)
    .map(r => r.value);
  
  const signals = successes.filter(s => s.signal);
  const noSignals = successes.filter(s => !s.signal);
  const errors = results.filter(r => r.status === 'rejected' || (r.value?.error));
  
  let message = '';
  
  if (errors.length > 0) {
    message += `⚠️ *أخطاء:* ${errors.map(e => e.reason?.message || e.value?.error).join(', ')}\n\n`;
  }
  
  if (signals.length > 0) {
    message += `🚨 *إشارات شراء (${signals.length})* 🚨\n\n`;
    signals.forEach(s => {
      message += `💎 *${s.symbol}*: ${s.signal}\n`;
      message += `السعر: ${s.price} | RSI: ${s.rsi}\n`;
      message += `الدعم: ${s.support} | المقاومة: ${s.resistance}\n\n`;
    });
  } else {
    message += `⚪ *لا توجد إشارات شراء حالياً.*\n\n`;
  }
  
  if (noSignals.length > 0) {
    message += `📋 *باقي الأسهم (بدون إشارة):*\n`;
    message += noSignals.map(s => `• ${s.symbol}: ${s.price} (RSI: ${s.rsi})`).join('\n');
  }
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// 5. /test (للتجربة السريعة)
bot.onText(/^\/test$/i, async (msg) => {
  await bot.sendMessage(msg.chat.id, '✅ البوت شغال! جاري تحليل COMI...');
  const result = await analyzeStock('COMI');
  bot.sendMessage(msg.chat.id, `\`\`\`json\n${JSON.stringify(result, null, 2)}\`\`\``, {
    parse_mode: 'Markdown'
  });
});

console.log('✅ Bot is running and listening for commands...');