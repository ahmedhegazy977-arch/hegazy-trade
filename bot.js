const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const watchlist = new Map();
const priceAlerts = new Map();

// قائمة الأسهم
const EGX_LIST = ['COMI','EFID','ETEL','SWDY','HRHO','ESRS','PHDC','TMGH','ORWE','EAST','OCDI','EGBN','AMOC','ISPH','HELI','MNHD','OBEL','PHCI','RMDA','SODIC'];

// جلب السعر - طريقة أبسط
async function getPrice(symbol) {
  const sym = symbol.toUpperCase();
  
  try {
    // الطريقة 1: API بديل (مجاني)
    const url = `https://api.example.com/stocks/${sym}`; // هنبدله برابط شغال
    
    // نجرب Mubasher API لو موجود
    const response = await axios.get(`https://www.mubasher.info/api/markets/EGX/stocks/${sym}/ticker`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      },
      timeout: 8000
    }).catch(() => null);
    
    if(response && response.data) {
      return {
        price: response.data.last || response.data.price,
        source: 'Mubasher API'
      };
    }
    
    // الطريقة 2: Yahoo Finance
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.CA?range=1d&interval=1m`;
    const yahooResp = await axios.get(yahooUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    }).catch(() => null);
    
    if(yahooResp && yahooResp.data.chart?.result?.[0]?.meta?.regularMarketPrice) {
      return {
        price: yahooResp.data.chart.result[0].meta.regularMarketPrice,
        source: 'Yahoo'
      };
    }
    
    return null;
  } catch(e) {
    console.error(`Error fetching ${sym}:`, e.message);
    return null;
  }
}

// أمر البدء
bot.onText(/\/(start|ابدأ)/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `🚀 *بوت حجازي للتداول*\n\n` +
    `📊 الأوامر:\n` +
    `/price SYMBOL - سعر السهم\n` +
    `/فحص SYMBOL - فحص سهم\n` +
    `/مسح - مسح السوق\n` +
    `/اضافة SYMBOL - إضافة للمراقبة\n` +
    `/قائمة - قائمة المراقبة\n\n` +
    `مثال: /price EFID`,
    { parse_mode: 'Markdown' }
  );
});

// أمر السعر
bot.onText(/\/price\s+(\w+)/i, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  const loading = await bot.sendMessage(msg.chat.id, `⏳ جاري جلب ${symbol}...`);
  
  const data = await getPrice(symbol);
  
  if(!data) {
    return bot.editMessageText(`❌ فشل في جلب بيانات ${symbol}`, {
      chat_id: msg.chat.id,
      message_id: loading.message_id
    });
  }
  
  bot.editMessageText(
    `📊 *${symbol}*\n💰 السعر: ${data.price} جنيه\n📡 المصدر: ${data.source}`,
    {
      chat_id: msg.chat.id,
      message_id: loading.message_id,
      parse_mode: 'Markdown'
    }
  );
});

// أمر الفحص المبسط
bot.onText(/\/فحص\s+(\w+)/i, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  const loading = await bot.sendMessage(msg.chat.id, `🔍 فحص ${symbol}...`);
  
  const data = await getPrice(symbol);
  
  if(!data) {
    return bot.editMessageText(`❌ فشل في جلب ${symbol}`, {
      chat_id: msg.chat.id,
      message_id: loading.message_id
    });
  }
  
  bot.editMessageText(
    `📊 *${symbol}*\n💰 ${data.price} جنيه\n📡 ${data.source}\n\n⚠️ البيانات الأساسية متاحة قريباً`,
    {
      chat_id: msg.chat.id,
      message_id: loading.message_id,
      parse_mode: 'Markdown'
    }
  );
});

// أمر المسح السريع
bot.onText(/\/مسح/, async (msg) => {
  const loading = await bot.sendMessage(msg.chat.id, '📊 جاري مسح السوق...');
  
  let results = [];
  for(const sym of EGX_LIST.slice(0, 10)) { // أول 10 أسهم فقط
    const data = await getPrice(sym);
    if(data) {
      results.push(`${sym}: ${data.price}`);
    }
  }
  
  bot.editMessageText(
    `📊 *نتائج المسح:*\n\n` + results.join('\n') || '❌ فشل في جلب البيانات',
    {
      chat_id: msg.chat.id,
      message_id: loading.message_id,
      parse_mode: 'Markdown'
    }
  );
});

// قائمة المراقبة
bot.onText(/\/اضافة\s+(\w+)/i, (msg, match) => {
  const symbol = match[1].toUpperCase();
  const chatId = msg.chat.id;
  
  if(!watchlist.has(chatId)) watchlist.set(chatId, []);
  const list = watchlist.get(chatId);
  
  if(!list.includes(symbol)) {
    list.push(symbol);
    bot.sendMessage(msg.chat.id, `✅ أضيف ${symbol}`);
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ ${symbol} موجود بالفعل`);
  }
});

bot.onText(/\/قائمة/, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  bot.sendMessage(msg.chat.id, 
    list.length ? '📋 *قائمة المراقبة:*\n' + list.map((s,i)=>`${i+1}. ${s}`).join('\n') : '📭 فارغة',
    { parse_mode: 'Markdown' }
  );
});

console.log('✅ Bot Started - Simplified Version');