const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// قائمة الأسهم المصرية (رموز مباشر)
const MUBASHER_SYMBOLS = [
  'EFID','COMI','ETEL','SWDY','HRHO','ESRS','PHDC','TMGH','SODIC','MNHD',
  'INEG','LUTS','OCDI','FWRY','UNIP','ISPH','EAST','ORWE','EKHO','HELI',
  'ALEX','CAIB','CIHB','EBNK','EKBN','NSGB','SAIB','LXIN','MOPH','NILE',
  'QALY','PALM','JUFO','ZMZA','KARO','HOD','DOMT','PHCI','RMDA','MKPH',
  'EIPIC','TELS','ITPAC','MCDR','SKPC','APPC','OLFI','TALM','UPFD','WUFA',
  'YRGN','ZOD','AGRI','CEMI','CHEM','CLHO','EGAS','ETRA','FERT','GAS',
  'GLBC','IRON','MINA','MNQC','PACK','PAPR','PLAS','POLY','RUBR','SAND',
  'SHMD','STLT','TEXT','TILE','TIMB','AUTO','SPIN','EGTS','THMD','ALHE',
  'HOTL','TOUR','TRVL','ELEC','ENER','FINS','HOLD','INVS','LEAS','REIT','SUKN'
];

const tvLink = (sym) => `https://www.tradingview.com/chart/?symbol=EGX:${sym}`;

// ==================== جلب السعر من مباشر (نسخة JS خفيفة) ====================
async function fetchMubasher(symbol) {
  const url = `https://www.mubasher.info/markets/EGX/stocks/${symbol.toUpperCase()}`;
  
  // Headers زي الكود بتاعك بالظبط
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://www.mubasher.info/",
    "Connection": "keep-alive"
  };

  try {
    const { data: html } = await axios.get(url, { headers, timeout: 12000 });

    // طريقة 1: البحث عن data-qa (الأكثر استقراراً في مباشر)
    const qaMatch = html.match(/data-qa="last-price"[^>]*>([\d,]+\.\d+)/);
    if (qaMatch) return parseFloat(qaMatch[1].replace(/,/g, ''));

    // طريقة 2: البحث عن stock-price__value
    const priceMatch = html.match(/class="[^"]*stock-price__value[^"]*"[^>]*>([\d,]+\.\d+)/);
    if (priceMatch) return parseFloat(priceMatch[1].replace(/,/g, ''));

    // طريقة 3: Regex عام للبحث عن أي سعر في نطاق معقول (1 - 10000)
    const genericMatch = html.match(/>([\d]{1,5}\.\d{2})\s*(ج\.م|جنيه|EGP)/);
    if (genericMatch) return parseFloat(genericMatch[1]);

    // لو مفيش سعر واضح
    return null;
  } catch (e) {
    console.log(`Mubasher failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ==================== فاول باك: ياهو (لضمان الاستمرار) ====================
async function fetchYahooFallback(symbol) {
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbol}.CA`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });
    const res = data.quoteResponse?.result?.[0];
    if (res?.regularMarketPrice) {
      return {
        price: res.regularMarketPrice,
        change: res.regularMarketChange || 0,
        changePercent: res.regularMarketChangePercent || 0,
        volume: res.regularMarketVolume || 0,
        source: 'Yahoo Fallback'
      };
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ==================== دالة الجلب الرئيسية (مباشر أولاً) ====================
async function fetchPrice(symbol) {
  // نجرب مباشر الأول
  const mubasherPrice = await fetchMubasher(symbol);
  if (mubasherPrice) {
    return {
      price: mubasherPrice,
      change: 0, // مباشر مش دايماً بيبعت التغيير في المكان السهل
      changePercent: 0,
      volume: 0,
      source: 'Mubasher.info (Scraped)'
    };
  }
  
  // لو فشل، نجرب ياهو
  const yahoo = await fetchYahooFallback(symbol);
  if (yahoo) return yahoo;
  
  return null;
}

// ==================== أوامر البوت ====================
bot.onText(/^\/start$/i, (msg) => {
  bot.sendMessage(msg.chat.id, '🤖 Hegazy Bot (Mubasher Edition)\n\nCommands:\n/price SYMBOL\n/list\n/chart SYMBOL');
});

bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!MUBASHER_SYMBOLS.includes(sym)) {
    return bot.sendMessage(msg.chat.id, `❌ ${sym} not supported.\nUse /list to see available symbols.`);
  }
  
  const load = await bot.sendMessage(msg.chat.id, '⏳ Fetching from Mubasher...');
  const data = await fetchPrice(sym);
  
  if (!data) {
    return bot.editMessageText('❌ Failed to fetch. Market closed or source busy. Try again in 2 mins.', 
      { chat_id: msg.chat.id, message_id: load.message_id });
  }

  const icon = data.change >= 0 ? '📈' : '📉';
  let txt = `📊 ${sym}\n💰 Price: ${data.price.toFixed(2)} EGP\n`;
  if (data.changePercent !== 0) {
    txt += `${icon} Change: ${data.change.toFixed(2)} (${data.changePercent.toFixed(2)}%)\n`;
  }
  if (data.volume > 0) txt += `📦 Vol: ${data.volume.toLocaleString()}\n`;
  txt += `🌐 Source: ${data.source}\n🔗 ${tvLink(sym)}`;
  
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/list$/i, (msg) => {
  const list = MUBASHER_SYMBOLS.slice(0, 30).join(', ') + '...';
  bot.sendMessage(msg.chat.id, `✅ Supported (${MUBASHER_SYMBOLS.length} stocks):\n${list}`);
});

bot.onText(/^\/chart\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!MUBASHER_SYMBOLS.includes(sym)) return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
  bot.sendMessage(msg.chat.id, `📈 ${sym} Live Chart:\n${tvLink(sym)}`);
});

console.log('✅ Mubasher Bot Started. Ready for Egyptian Market.');