const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// قائمة الأسهم
const STOCKS = {
  'EFID':'EFID.CA','COMI':'COMI.CA','ETEL':'ETEL.CA','SWDY':'SWDY.CA','HRHO':'HRHO.CA',
  'ESRS':'ESRS.CA','PHDC':'PHDC.CA','TMGH':'TMGH.CA','SODIC':'SODIC.CA','MNHD':'MNHD.CA',
  'INEG':'INEG.CA','LUTS':'LUTS.CA','OCDI':'OCDI.CA','FWRY':'FWRY.CA','UNIP':'UNIP.CA',
  'ISPH':'ISPH.CA','EAST':'EAST.CA','ORWE':'ORWE.CA','EKHO':'EKHO.CA','HELI':'HELI.CA'
};

const tvLink = (sym) => `https://www.tradingview.com/chart/?symbol=EGX:${sym}`;

// ==================== محرك الجلب المزدوج (API + Regex) ====================
async function fetchPrice(symbol) {
  const ticker = STOCKS[symbol];
  if (!ticker) return null;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  // المحاولة 1: Yahoo API
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1m`;
    const { data } = await axios.get(url, { headers, timeout: 8000 });
    const res = data.chart?.result?.[0];
    if (res?.meta?.regularMarketPrice) {
      return {
        price: res.meta.regularMarketPrice,
        change: res.meta.regularMarketPrice - (res.meta.previousClose || res.meta.regularMarketPrice),
        changePercent: res.meta.regularMarketChangePercent || 0,
        volume: res.meta.regularMarketVolume || 0,
        source: 'Yahoo API'
      };
    }
  } catch (e) { /* فشل API، ننتقل للمحاولة 2 */ }

  // المحاولة 2: Yahoo HTML Fallback (Regex)
  try {
    const url = `https://finance.yahoo.com/quote/${ticker}`;
    const { data: html } = await axios.get(url, { headers, timeout: 10000 });
    
    // استخراج البيانات من الـ JSON المضمن داخل الصفحة
    const priceMatch = html.match(/"regularMarketPrice":\{"raw":([\d.]+)/);
    const prevMatch = html.match(/"regularMarketPreviousClose":\{"raw":([\d.]+)/);
    const volMatch = html.match(/"regularMarketVolume":\{"raw":([\d.]+)/);
    
    if (priceMatch) {
      const price = parseFloat(priceMatch[1]);
      const prev = prevMatch ? parseFloat(prevMatch[1]) : price;
      return {
        price,
        change: price - prev,
        changePercent: ((price - prev) / prev) * 100,
        volume: volMatch ? parseInt(volMatch[1]) : 0,
        source: 'Yahoo Fallback (Stable)'
      };
    }
  } catch (e) { /* فشل الكل */ }

  return null;
}

// ==================== أوامر البوت ====================
bot.onText(/^\/start$/i, (msg) => {
  bot.sendMessage(msg.chat.id, '🤖 Hegazy Trade Bot (Light & Stable)\n\nCommands:\n/price SYMBOL\n/list\n/chart SYMBOL');
});

bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
  
  const load = await bot.sendMessage(msg.chat.id, '⏳ Fetching...');
  const data = await fetchPrice(sym);
  
  if (!data) {
    return bot.editMessageText(' Failed to fetch data. Market might be closed or source is busy. Try again in 2 mins.', 
      { chat_id: msg.chat.id, message_id: load.message_id });
  }

  const icon = data.change >= 0 ? '📈' : '📉';
  let txt = ` ${sym}\n💰 Price: ${data.price.toFixed(2)} EGP\n${icon} Change: ${data.change.toFixed(2)} (${data.changePercent.toFixed(2)}%)\n📦 Vol: ${data.volume.toLocaleString()}\n Source: ${data.source}\n ${tvLink(sym)}`;
  
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id });
});

bot.onText(/^\/list$/i, (msg) => {
  bot.sendMessage(msg.chat.id, `✅ Supported: ${Object.keys(STOCKS).join(', ')}`);
});

bot.onText(/^\/chart\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
  bot.sendMessage(msg.chat.id, `📈 ${sym} Live Chart:\n${tvLink(sym)}`);
});

console.log('✅ Light Bot Started. Ready for commands.');