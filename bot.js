const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const API_KEY = process.env.TWELVE_API_KEY;
const bot = new TelegramBot(TOKEN, { polling: true });

const watchlist = new Map();

// قائمة الأسهم المصرية (رموز Twelve Data)
const EGX_STOCKS = {
  'EFID': 'EFID.EGX',
  'COMI': 'COMI.EGX',
  'ETEL': 'ETEL.EGX',
  'SWDY': 'SWDY.EGX',
  'HRHO': 'HRHO.EGX',
  'ESRS': 'ESRS.EGX',
  'PHDC': 'PHDC.EGX',
  'TMGH': 'TMGH.EGX',
  'EAST': 'EAST.EGX',
  'EGBN': 'EGBN.EGX',
  'OCDI': 'OCDI.EGX',
  'ISPH': 'ISPH.EGX',
  'HELI': 'HELI.EGX',
  'MNHD': 'MNHD.EGX',
  'OBEL': 'OBEL.EGX',
  'PHCI': 'PHCI.EGX',
  'RMDA': 'RMDA.EGX',
  'SODIC': 'SODIC.EGX'
};

// جلب السعر من Twelve Data
async function getPrice(symbol) {
  const sym = symbol.toUpperCase();
  const ticker = EGX_STOCKS[sym];
  
  if(!ticker) {
    return { error: `❌ ${sym} غير موجود في القائمة` };
  }
  
  try {
    const url = `https://api.twelvedata.com/price?symbol=${ticker}&apikey=${API_KEY}`;
    const response = await axios.get(url, { timeout: 10000 });
    
    if(response.data.price) {
      return {
        price: parseFloat(response.data.price),
        symbol: sym,
        source: 'Twelve Data'
      };
    }
    
    return { error: `❌ فشل في جلب ${sym}` };
  } catch(e) {
    console.error(`Error ${sym}:`, e.message);
    return { error: `❌ خطأ في الاتصال` };
  }
}

// جلب بيانات كاملة
async function getQuote(symbol) {
  const sym = symbol.toUpperCase();
  const ticker = EGX_STOCKS[sym];
  
  if(!ticker) return { error: `غير موجود` };
  
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${ticker}&apikey=${API_KEY}`;
    const response = await axios.get(url, { timeout: 10000 });
    const d = response.data;
    
    if(d.symbol) {
      return {
        symbol: d.symbol,
        price: parseFloat(d.price),
        change: parseFloat(d.change),
        changePercent: parseFloat(d.change_percent),
        high: parseFloat(d.high),
        low: parseFloat(d.low),
        open: parseFloat(d.open),
        previousClose: parseFloat(d.previous_close),
        volume: parseInt(d.volume || 0)
      };
    }
    
    return { error: `فشل` };
  } catch(e) {
    return { error: `خطأ` };
  }
}

// الأوامر
bot.onText(/\/(start|ابدأ)/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `🚀 *بوت حجازي للتداول*\n\n` +
    `📊 الأوامر:\n` +
    `/price SYMBOL - سعر السهم\n` +
    `/quote SYMBOL - بيانات كاملة\n` +
    `/مسح - مسح السوق\n` +
    `/اضافة SYMBOL - إضافة للمراقبة\n` +
    `/قائمة - القائمة\n\n` +
    `مثال: /price EFID`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/price\s+(\w+)/i, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  const loading = await bot.sendMessage(msg.chat.id, `⏳ ${symbol}...`);
  
  const data = await getPrice(symbol);
  
  if(data.error) {
    return bot.editMessageText(data.error, {
      chat_id: msg.chat.id,
      message_id: loading.message_id
    });
  }
  
  bot.editMessageText(
    `📊 *${data.symbol}*\n💰 ${data.price} جنيه\n📡 ${data.source}`,
    {
      chat_id: msg.chat.id,
      message_id: loading.message_id,
      parse_mode: 'Markdown'
    }
  );
});

bot.onText(/\/quote\s+(\w+)/i, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  const loading = await bot.sendMessage(msg.chat.id, `⏳ ${symbol}...`);
  
  const data = await getQuote(symbol);
  
  if(data.error) {
    return bot.editMessageText(`❌ ${data.error}`, {
      chat_id: msg.chat.id,
      message_id: loading.message_id
    });
  }
  
  const changeEmoji = data.change >= 0 ? '📈' : '📉';
  const changeSign = data.change >= 0 ? '+' : '';
  
  bot.editMessageText(
    `📊 *${data.symbol}*\n\n` +
    `💰 السعر: ${data.price} جنيه\n` +
    `${changeEmoji} التغيير: ${changeSign}${data.change} (${changeSign}${data.changePercent}%)\n` +
    `📊 الافتتاح: ${data.open}\n` +
    `📈 الأعلى: ${data.high}\n` +
    `📉 الأدنى: ${data.low}\n` +
    `📅 الإغلاق السابق: ${data.previousClose}\n` +
    `📊 الحجم: ${data.volume.toLocaleString()}`,
    {
      chat_id: msg.chat.id,
      message_id: loading.message_id,
      parse_mode: 'Markdown'
    }
  );
});

bot.onText(/\/مسح/, async (msg) => {
  const loading = await bot.sendMessage(msg.chat.id, '📊 مسح السوق...');
  
  let results = [];
  for(const [sym, ticker] of Object.entries(EGX_STOCKS).slice(0, 10)) {
    const data = await getPrice(sym);
    if(!data.error) {
      results.push(`${sym}: ${data.price}`);
    }
  }
  
  bot.editMessageText(
    `📊 *السوق المصري*\n\n` + results.join('\n'),
    {
      chat_id: msg.chat.id,
      message_id: loading.message_id,
      parse_mode: 'Markdown'
    }
  );
});

bot.onText(/\/اضافة\s+(\w+)/i, (msg, match) => {
  const symbol = match[1].toUpperCase();
  const chatId = msg.chat.id;
  
  if(!watchlist.has(chatId)) watchlist.set(chatId, []);
  const list = watchlist.get(chatId);
  
  if(!list.includes(symbol)) {
    list.push(symbol);
    bot.sendMessage(msg.chat.id, `✅ أضيف ${symbol}`);
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ ${symbol} موجود`);
  }
});

bot.onText(/\/قائمة/, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  bot.sendMessage(msg.chat.id, 
    list.length ? '📋 *القائمة:*\n' + list.map((s,i)=>`${i+1}. ${s}`).join('\n') : '📭 فارغة',
    { parse_mode: 'Markdown' }
  );
});

console.log('✅ Bot Started with Twelve Data API');