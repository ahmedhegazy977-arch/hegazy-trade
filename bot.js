const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default;
const { RSI, EMA } = require('technicalindicators');

// 1. توكن البوت (من الأفضل تستخدم Environment Variables في Railway)
const TOKEN = process.env.TOKEN || '8372311269:AAHYGU-Bu1VnteJwpTUXkNwSMmcDNoUEfcg';
const bot = new TelegramBot(TOKEN, { polling: true });

// 2. قائمة الأسهم (رموز مباشر = رموز ياهو)
const WATCHLIST = ['COMI', 'FWRY', 'HRHO', 'ESRS', 'AMOC', 'ORWE', 'ABUK', 'PHDC', 'ETEL', 'SWDY'];

// ==================== دالة جلب السعر من مباشر ====================
async function fetchCurrentPriceFromMubasher(symbol) {
  const url = `https://www.mubasher.info/markets/EGX/stocks/${symbol.toUpperCase()}`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8",
    "Referer": "https://www.mubasher.info/"
  };

  try {
    const { data: html } = await axios.get(url, { headers, timeout: 10000 });
    
    // Regex لاستخراج السعر
    const qaMatch = html.match(/data-qa="last-price"[^>]*>([\d,]+\.\d+)/);
    if (qaMatch) return parseFloat(qaMatch[1].replace(/,/g, ''));
    
    const priceMatch = html.match(/class="[^"]*stock-price__value[^"]*"[^>]*>([\d,]+\.\d+)/);
    if (priceMatch) return parseFloat(priceMatch[1].replace(/,/g, ''));
    
    return null;
  } catch (e) {
    console.log(`Mubasher failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ==================== دالة جلب البيانات التاريخية من ياهو ====================
async function fetchHistoricalData(symbol) {
  try {
    const history = await yahooFinance.chart(`${symbol}.CA`, {
      period1: new Date(Date.now() - 65 * 24 * 60 * 60 * 1000),
      interval: '1d'
    });
    
    if (!history.quotes || history.quotes.length < 50) return null;
    return history.quotes;
  } catch (e) {
    console.log(`Yahoo failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ==================== دالة التحليل الفني المتقدم ====================
async function analyzeStock(symbol) {
  try {
    // 1. نجلب السعر الحالي من مباشر أولاً
    let currentPrice = await fetchCurrentPriceFromMubasher(symbol);
    let source = 'Mubasher.info';
    
    // 2. نجلب البيانات التاريخية من ياهو (ضرورية لحساب RSI و EMA)
    const quotes = await fetchHistoricalData(symbol);
    if (!quotes) return null;
    
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
    
    // 3. حساب المؤشرات الفنية
    const rsi = RSI.calculate({ period: 14, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    
    const currentRsi = rsi[rsi.length - 1];
    const currentEma50 = ema50[ema50.length - 1];
    
    // 4. حساب الدعم والمقاومة (آخر 20 يوم)
    const recentHighs = highs.slice(-20);
    const recentLows = lows.slice(-20);
    const resistance = Math.max(...recentHighs);
    const support = Math.min(...recentLows);
    
    // 5. حساب متوسط حجم التداول (آخر 10 أيام)
    const recentVolumes = volumes.slice(-11, -1);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    
    let signal = null;
    let reason = "";
    
    // ==================== الفلاتر المتقدمة ====================
    
    // فلتر 1: اختراق مقاومة قوي
    if (currentPrice >= resistance * 0.99) {
      if (currentVolume > avgVolume * 1.2 && currentPrice > currentEma50) {
        signal = "🚀 اختراق مقاومة قوي (Breakout)";
        reason = `كسر قمة 20 يوم (${resistance.toFixed(2)}) بحجم تداول عالي (${(currentVolume/1000000).toFixed(1)}M)`;
      }
    }
    // فلتر 2: ارتداد من دعم قوي
    else {
      const distanceToSupport = ((currentPrice - support) / support) * 100;
      if (distanceToSupport <= 3 && currentRsi < 35 && currentPrice > currentEma50) {
        signal = "🛡️ ارتداد من دعم قوي (Support Bounce)";
        reason = `السعر عند الدعم (${support.toFixed(2)}) مع تشبع بيعي (RSI: ${currentRsi.toFixed(1)})`;
      }
    }
    
    if (!signal) return null;
    
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
    console.error(`Error analyzing ${symbol}:`, error.message);
    return null;
  }
}

// ==================== أمر التليجرام ====================
bot.onText(/\/scan/, async (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, "⏳ جاري فحص السوق (مباشر + ياهو) بالفلاتر المتقدمة...");
  
  const results = await Promise.all(WATCHLIST.map(symbol => analyzeStock(symbol)));
  const buySignals = results.filter(r => r !== null);
  
  if (buySignals.length === 0) {
    bot.sendMessage(chatId, "⚠️ لا توجد إشارات شراء تطابق الفلاتر حالياً.");
    return;
  }
  
  let message = "🚨 *إشارات الشراء المؤكدة:* 🚨\n\n";
  buySignals.forEach(stock => {
    message += `💎 *${stock.symbol}*\n`;
    message += `السعر: ${stock.price} | المصدر: ${stock.source}\n`;
    message += `الدعم: ${stock.support} | المقاومة: ${stock.resistance}\n`;
    message += `RSI: ${stock.rsi} | EMA 50: ${stock.ema50}\n`;
    message += `📌 الإشارة: *${stock.signal}*\n`;
    message += `📝 السبب: ${stock.reason}\n`;
    message += `-------------------------\n`;
  });
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

console.log("✅ البوت يعمل الآن (Mubasher + Yahoo + Filters)...");