const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN || '8372311269:AAHYGU-Bu1VnteJwpTUXkNwSMmcDNoUEfcg';
const bot = new TelegramBot(TOKEN, { polling: true });

const WATCHLIST = ['COMI', 'FWRY', 'HRHO', 'ESRS', 'AMOC', 'EFID', 'ETEL', 'PHDC', 'TMGH', 'SODIC'];

console.log('🚀 Hegazy Trade Bot (Lite) Started...');

// ==================== المؤشرات الفنية (يدوي - بدون مكتبات) ====================
const calc = {
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
    return avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
};

// ==================== جلب البيانات من ياهو (API مباشر) ====================
async function fetchYahooData(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.CA?range=3mo&interval=1d`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    
    const result = data.chart?.result?.[0];
    if (!result || !result.indicators?.quote?.[0]) return null;
    
    const quotes = result.indicators.quote[0];
    const closes = (quotes.close || []).filter(v => v != null);
    const volumes = (quotes.volume || []).filter(v => v != null);
    
    if (closes.length < 50) return null;
    
    return {
      closes,
      volumes,
      currentPrice: result.meta.regularMarketPrice || closes[closes.length - 1],
      prevClose: result.meta.previousClose || closes[closes.length - 2],
      volume: volumes[volumes.length - 1] || 0
    };
  } catch (e) {
    console.log(`❌ Yahoo fetch failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ==================== تحليل السهم ====================
async function analyzeStock(symbol) {
  try {
    const data = await fetchYahooData(symbol);
    if (!data) return { symbol, error: 'No data available' };
    
    const { closes, volumes, currentPrice, prevClose, volume } = data;
    
    // حساب المؤشرات
    const rsi = calc.rsi(closes);
    const ema50 = calc.ema(closes, 50);
    const ema200 = calc.ema(closes, 200);
    
    // الدعم والمقاومة (آخر 20 يوم)
    const recent = closes.slice(-20);
    const support = Math.min(...recent);
    const resistance = Math.max(...recent);
    
    // متوسط الحجم
    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    
    // الفلتر
    let signal = null;
    if (currentPrice >= resistance * 0.99 && volume > avgVol * 1.2 && (!ema50 || currentPrice > ema50)) {
      signal = "🚀 اختراق مقاومة";
    } else if (currentPrice <= support * 1.02 && rsi < 40 && (!ema50 || currentPrice > ema50)) {
      signal = "🛡️ ارتداد من دعم";
    }
    
    return {
      symbol,
      price: currentPrice.toFixed(2),
      change: (currentPrice - prevClose).toFixed(2),
      changePercent: ((currentPrice - prevClose) / prevClose * 100).toFixed(2),
      rsi: rsi?.toFixed(1) || 'N/A',
      ema50: ema50?.toFixed(2) || 'N/A',
      ema200: ema200?.toFixed(2) || 'N/A',
      support: support.toFixed(2),
      resistance: resistance.toFixed(2),
      volume: (volume / 1000000).toFixed(2) + 'M',
      signal
    };
  } catch (err) {
    console.error(`❌ ${symbol} error: ${err.message}`);
    return { symbol, error: err.message };
  }
}

// ==================== الأوامر ====================

bot.onText(/^\/start$/i, (msg) => {
  bot.sendMessage(msg.chat.id, 
    '🤖 *Hegazy Trade Bot (Lite)*\n\n' +
    'الأوامر:\n' +
    '/scan - فحص السوق\n' +
    '/price SYMBOL - سعر سهم (مثال: /price COMI)\n' +
    '/filter SYMBOL - تحليل فني\n' +
    '/list - الأسهم المدعومة', 
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/list$/i, (msg) => {
  bot.sendMessage(msg.chat.id, `✅ المدعومة:\n${WATCHLIST.join(', ')}`);
});

bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!WATCHLIST.includes(sym)) return bot.sendMessage(msg.chat.id, `❌ ${sym} غير مدعوم`);
  
  const load = await bot.sendMessage(msg.chat.id, '⏳ جاري الجلب...');
  const data = await fetchYahooData(sym);
  
  if (!data) return bot.editMessageText('❌ فشل جلب البيانات', {
    chat_id: msg.chat.id, message_id: load.message_id
  });
  
  const icon = data.currentPrice >= data.prevClose ? '📈' : '📉';
  const txt = `📊 *${sym}*\n💰 ${data.currentPrice.toFixed(2)} EGP\n${icon} ${data.currentPrice - data.prevClose >= 0 ? '+' : ''}${(data.currentPrice - data.prevClose).toFixed(2)} (${((data.currentPrice - data.prevClose)/data.prevClose*100).toFixed(2)}%)\n📦 حجم: ${(data.volume/1000000).toFixed(2)}M`;
  
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'Markdown' });
});

bot.onText(/^\/filter\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!WATCHLIST.includes(sym)) return bot.sendMessage(msg.chat.id, `❌ ${sym} غير مدعوم`);
  
  const load = await bot.sendMessage(msg.chat.id, '🔍 جاري التحليل...');
  const result = await analyzeStock(sym);
  
  if (result.error) return bot.editMessageText(`❌ ${result.error}`, {
    chat_id: msg.chat.id, message_id: load.message_id
  });
  
  let txt = `🎯 *${result.symbol}*\n💰 ${result.price}\n`;
  txt += `📊 RSI: ${result.rsi} | EMA50: ${result.ema50}\n`;
  txt += `🔻 دعم: ${result.support} | 🔺 مقاومة: ${result.resistance}\n`;
  txt += result.signal ? `\n✅ *${result.signal}*` : '\n⚪ بدون إشارة حالياً';
  
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'Markdown' });
});

bot.onText(/^\/scan$/i, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '⏳ جاري الفحص... (15 ثانية)');
  
  const results = await Promise.allSettled(WATCHLIST.map(analyzeStock));
  
  const signals = results
    .filter(r => r.status === 'fulfilled' && r.value?.signal)
    .map(r => r.value);
  
  const noSignals = results
    .filter(r => r.status === 'fulfilled' && r.value && !r.value.signal && !r.value.error)
    .map(r => r.value);
  
  let message = '';
  
  if (signals.length > 0) {
    message += `🚨 *إشارات شراء (${signals.length})* 🚨\n\n`;
    signals.forEach(s => {
      message += `💎 *${s.symbol}*: ${s.signal}\n`;
      message += `السعر: ${s.price} | RSI: ${s.rsi}\n`;
      message += `دعم: ${s.support} | مقاومة: ${s.resistance}\n\n`;
    });
  } else {
    message += `⚪ *لا توجد إشارات شراء حالياً.*\n\n`;
  }
  
  if (noSignals.length > 0) {
    message += `📋 *باقي الأسهم:*\n`;
    message += noSignals.map(s => `• ${s.symbol}: ${s.price} (RSI: ${s.rsi})`).join('\n');
  }
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/^\/test$/i, async (msg) => {
  await bot.sendMessage(msg.chat.id, '✅ البوت شغال! جاري تحليل COMI...');
  const result = await analyzeStock('COMI');
  bot.sendMessage(msg.chat.id, `\`\`\`json\n${JSON.stringify(result, null, 2)}\`\`\``, {
    parse_mode: 'Markdown'
  });
});

console.log('✅ Bot listening for commands...');