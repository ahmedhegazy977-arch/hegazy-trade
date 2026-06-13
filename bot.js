const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default;
const { RSI, EMA } = require('technicalindicators');

// 1. التوكن (لو رفعت TOKEN في Railway، هياخده من هناك، وإلا هيستخدم ده)
const TOKEN = process.env.TOKEN || '8372311269:AAHYGU-Bu1VnteJwpTUXkNwSMmcDNoUEfcg';
const bot = new TelegramBot(TOKEN, { polling: true });

// 2. قائمة الأسهم
const WATCHLIST = ['COMI', 'FWRY', 'HRHO', 'ESRS', 'AMOC'];

// ==================== جلب السعر من مباشر ====================
async function fetchMubasherPrice(symbol) {
  const url = `https://www.mubasher.info/markets/EGX/stocks/${symbol.toUpperCase()}`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8",
    "Referer": "https://www.mubasher.info/"
  };

  try {
    const { data: html } = await axios.get(url, { headers, timeout: 10000 });
    
    const qaMatch = html.match(/data-qa="last-price"[^>]*>([\d,]+\.\d+)/);
    if (qaMatch) return parseFloat(qaMatch[1].replace(/,/g, ''));
    
    const priceMatch = html.match(/class="[^"]*stock-price__value[^"]*"[^>]*>([\d,]+\.\d+)/);
    if (priceMatch) return parseFloat(priceMatch[1].replace(/,/g, ''));
    
    return null;
  } catch (e) {
    console.log(`❌ Mubasher failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ==================== جلب البيانات من ياهو ====================
async function fetchYahooData(symbol) {
  try {
    const history = await yahooFinance.chart(`${symbol}.CA`, {
      period1: new Date(Date.now() - 65 * 24 * 60 * 60 * 1000),
      interval: '1d'
    });
    
    if (!history.quotes || history.quotes.length < 50) {
      console.log(`⚠️ Yahoo returned insufficient data for ${symbol}`);
      return null;
    }
    return history.quotes;
  } catch (e) {
    console.log(`❌ Yahoo failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ==================== تحليل السهم ====================
async function analyzeStock(symbol) {
  try {
    console.log(`🔍 Analyzing ${symbol}...`);
    
    // 1. نجلب السعر الحالي من مباشر
    let currentPrice = await fetchMubasherPrice(symbol);
    let source = 'Mubasher.info';
    
    // 2. نجلب البيانات التاريخية من ياهو
    const quotes = await fetchYahooData(symbol);
    if (!quotes) {
      return { symbol, error: 'فشل جلب البيانات التاريخية من ياهو' };
    }
    
    const closes = quotes.map(q => q.close).filter(v => v != null);
    const highs = quotes.map(q => q.high).filter(v => v != null);
    const lows = quotes.map(q => q.low).filter(v => v != null);
    const volumes = quotes.map(q => q.volume).filter(v => v != null);
    
    // لو مباشر فشل، نستخدم آخر سعر من ياهو
    if (!currentPrice) {
      currentPrice = closes[closes.length - 1];
      source = 'Yahoo Finance';
    }
    
    const currentVolume = volumes[volumes.length - 1];
    
    // 3. حساب المؤشرات
    const rsi = RSI.calculate({ period: 14, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    
    const currentRsi = rsi[rsi.length - 1];
    const currentEma50 = ema50[ema50.length - 1];
    
    // 4. حساب الدعم والمقاومة
    const recentHighs = highs.slice(-20);
    const recentLows = lows.slice(-20);
    const resistance = Math.max(...recentHighs);
    const support = Math.min(...recentLows);
    
    // 5. متوسط حجم التداول
    const recentVolumes = volumes.slice(-11, -1);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    
    let signal = null;
    let reason = "";
    
    // ==================== الفلاتر ====================
    
    // فلتر 1: اختراق مقاومة
    if (currentPrice >= resistance * 0.99) {
      if (currentVolume > avgVolume * 1.2 && currentPrice > currentEma50) {
        signal = "🚀 اختراق مقاومة قوي";
        reason = `كسر قمة 20 يوم (${resistance.toFixed(2)}) بحجم تداول عالي`;
      }
    }
    // فلتر 2: ارتداد من دعم
    else {
      const distanceToSupport = ((currentPrice - support) / support) * 100;
      if (distanceToSupport <= 3 && currentRsi < 35 && currentPrice > currentEma50) {
        signal = "🛡️ ارتداد من دعم قوي";
        reason = `السعر عند الدعم (${support.toFixed(2)}) مع تشبع بيعي (RSI: ${currentRsi.toFixed(1)})`;
      }
    }
    
    // لو مفيش إشارة، نرجع تفاصيل السهم عشان نعرف ليه ما دخلش
    if (!signal) {
      return {
        symbol,
        noSignal: true,
        price: currentPrice.toFixed(2),
        support: support.toFixed(2),
        resistance: resistance.toFixed(2),
        rsi: currentRsi.toFixed(1),
        ema50: currentEma50.toFixed(2),
        volume: (currentVolume / 1000000).toFixed(1) + 'M',
        reason: `السعر ${currentPrice.toFixed(2)} | الدعم ${support.toFixed(2)} | المقاومة ${resistance.toFixed(2)} | RSI ${currentRsi.toFixed(1)} | EMA50 ${currentEma50.toFixed(2)}`
      };
    }
    
    return {
      symbol,
      price: currentPrice.toFixed(2),
      support: support.toFixed(2),
      resistance: resistance.toFixed(2),
      rsi: currentRsi.toFixed(1),
      ema50: currentEma50.toFixed(2),
      volume: (currentVolume / 1000000).toFixed(1) + 'M',
      signal,
      reason,
      source
    };
    
  } catch (error) {
    console.error(`💥 Error in ${symbol}:`, error.message);
    return { symbol, error: error.message };
  }
}

// ==================== أمر /scan ====================
bot.onText(/\/scan/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    await bot.sendMessage(chatId, "⏳ جاري فحص السوق... (قد يستغرق 15-20 ثانية)");
    
    console.log("🚀 Starting scan...");
    const results = await Promise.all(WATCHLIST.map(symbol => analyzeStock(symbol)));
    console.log("✅ Scan completed. Results:", results);
    
    // فصل الأسهم اللي عندها إشارة عن اللي مفيش
    const buySignals = results.filter(r => r && r.signal);
    const noSignals = results.filter(r => r && r.noSignal);
    const errors = results.filter(r => r && r.error);
    
    let message = "";
    
    // رسائل الأخطاء
    if (errors.length > 0) {
      message += `❌ *أخطاء في الفحص:*\n`;
      errors.forEach(e => { message += `• ${e.symbol}: ${e.error}\n`; });
      message += `\n`;
    }
    
    // إشارات الشراء
    if (buySignals.length > 0) {
      message += `🚨 *إشارات شراء مؤكدة (${buySignals.length}):* 🚨\n\n`;
      buySignals.forEach(stock => {
        message += `💎 *${stock.symbol}*\n`;
        message += `السعر: ${stock.price} | المصدر: ${stock.source}\n`;
        message += `الدعم: ${stock.support} | المقاومة: ${stock.resistance}\n`;
        message += `RSI: ${stock.rsi} | EMA 50: ${stock.ema50}\n`;
        message += `📌 الإشارة: *${stock.signal}*\n`;
        message += `📝 السبب: ${stock.reason}\n`;
        message += `-------------------------\n`;
      });
    } else {
      message += `⚠️ *لا توجد إشارات شراء تطابق الفلاتر.*\n\n`;
    }
    
    // تفاصيل الأسهم اللي ما حققتش الشروط (عشان نعرف ليه)
    if (noSignals.length > 0) {
      message += `📊 *تفاصيل الأسهم التي لم تحقق الشروط:*\n`;
      noSignals.forEach(stock => {
        message += `• *${stock.symbol}*: ${stock.reason}\n`;
      });
    }
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error("💥 Critical error in /scan:", error);
    await bot.sendMessage(chatId, `❌ حدث خطأ فادح:\n${error.message}`);
  }
});

// اختبار سريع عند التشغيل
bot.onText(/\/test/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, "✅ البوت يعمل! جاري اختبار COMI...");
  
  const result = await analyzeStock('COMI');
  await bot.sendMessage(chatId, `نتيجة COMI:\n${JSON.stringify(result, null, 2)}`);
});

console.log("✅ البوت يعمل الآن... جرب /scan أو /test");