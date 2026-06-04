const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

//  هام جداً: حط التوكن بتاعك هنا بين علامات التنصيص
const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// دالة لجلب السعر من Yahoo Finance
async function getPrice(symbol) {
  const ticker = `${symbol.toUpperCase()}.CA`; // .CA للسوق المصري
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`;

  try {
    const { data } = await axios.get(url);
    const result = data.chart.result[0];

    if (!result || !result.meta) {
      return `❌ لم أجد سهم باسم: ${symbol}`;
    }

    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const change = meta.regularMarketChange;
    const changePercent = meta.regularMarketChangePercent;

    // تنسيق الرسالة
    return `📈 *${symbol.toUpperCase()}*\n` +
           `💰 السعر: ${price} جنيه\n` +
           ` التغير: ${change} (${changePercent}%)`;

  } catch (error) {
    return `⚠️ خطأ في الاتصال بالخادم`;
  }
}

// أمر /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, ` أهلاً بك في *Hegazy Trade Bot*!

📊 بيانات البورصة المصرية (متأخرة 15 دقيقة)

🔹 جرب الآن: /price CIB`, { parse_mode: 'Markdown' });
});

// أمر /price
bot.onText(/\/price\s+(\w+)/i, async (msg, match) => {
  const symbol = match[1];
  const loadingMsg = await bot.sendMessage(msg.chat.id, `🔍 جاري البحث عن ${symbol}...`);
  
  try {
    const result = await getPrice(symbol);
    bot.editMessageText(result, {
      chat_id: msg.chat.id,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    bot.editMessageText('حدث خطأ غير متوقع.', {
      chat_id: msg.chat.id,
      message_id: loadingMsg.message_id
    });
  }
});

console.log('✅ Hegazy Trade Bot is running on Yahoo Finance...');