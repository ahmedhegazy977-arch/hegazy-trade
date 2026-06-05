const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const watchlist = new Map();

// خريطة الرموز لجوجل فاينانس (الرمز:CAI للبورصة المصرية)
const STOCKS = {
  'EFID': 'EFID:CAI',
  'COMI': 'COMI:CAI',
  'ETEL': 'ETEL:CAI',
  'SWDY': 'SWDY:CAI',
  'HRHO': 'HRHO:CAI',
  'ESRS': 'ESRS:CAI',
  'PHDC': 'PHDC:CAI',
  'TMGH': 'TMGH:CAI',
  'EAST': 'EAST:CAI',
  'EGBN': 'EGBN:CAI',
  'OCDI': 'OCDI:CAI',
  'ISPH': 'ISPH:CAI',
  'MNHD': 'MNHD:CAI',
  'OBEL': 'OBEL:CAI',
  'SODIC': 'SODIC:CAI'
};

// دالة جلب السعر من جوجل
async function getPrice(symbol) {
  const query = STOCKS[symbol.toUpperCase()];
  if (!query) return { err: '❌ الرمز غير مدعوم' };

  try {
    // رابط جوجل فاينانس
    const url = `https://www.google.com/finance/quote/${query}`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 10000
    });

    const $ = cheerio.load(data);

    // استخراج السعر والتغيير
    // جوجل بيحط السعر في div بـ class معين
    let price = $('.YMlKec').first().text().trim(); 
    // وأحيانا بيكون في مكان تاني لو الصفحة اتغيرت، نجرب بديل
    if (!price) price = $('[data-price]').first().text().trim();

    let change = $('.P6K39c').first().text().trim(); // النسبة المئوية
    if (!change) change = $('[data-price-change-percent]').first().text().trim();

    // تنظيف النص من "EGP" أو رموز
    price = price.replace('EGP', '').replace('ج.م', '').trim();
    
    if (price && !isNaN(parseFloat(price))) {
      return {
        ok: true,
        data: {
          symbol: symbol.toUpperCase(),
          price: price,
          change: change || '0.00%',
          source: 'Google Finance'
        }
      };
    }

    return { err: '❌ فشل في جلب البيانات، جرب تاني بعد شوية.' };
  } catch (e) {
    return { err: `❌ خطأ في الاتصال: ${e.message}` };
  }
}

// الأوامر
bot.onText(/^\/(start|ابدأ)$/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    ` <b>بوت حجازي تريد (نسخة جوجل)</b>\n\n` +
    `📊 <b>الأوامر:</b>\n` +
    `/سعر SYMBOL - سعر السهم الحالي\n` +
    `/اضافة SYMBOL - للمراقبة\n` +
    `/قائمتي - عرض القائمة\n\n` +
    `💡 مثال: <code>/سعر EFID</code>`, 
    { parse_mode: 'HTML' }
  );
});

bot.onText(/^\/سعر\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, `⏳ جاري البحث عن ${sym} من جوجل...`);
  const r = await getPrice(sym);

  if (r.err) {
    return bot.editMessageText(r.err, { chat_id: msg.chat.id, message_id: load.message_id });
  }

  const d = r.data;
  const txt = `📊 <b>${d.symbol}</b>\n` +
              `💰 السعر: <b>${d.price}</b> جنيه\n` +
              `📈 التغيير: ${d.change}\n` +
              `📡 المصدر: ${d.source}`;

  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'HTML' });
});

bot.onText(/^\/اضافة\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  const cid = msg.chat.id;
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, '❌ الرمز غير مدعوم');
  
  if (!watchlist.has(cid)) watchlist.set(cid, []);
  const list = watchlist.get(cid);
  
  if (!list.includes(sym)) {
    list.push(sym);
    bot.sendMessage(msg.chat.id, `✅ تمت إضافة ${sym} للمراقبة`);
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ ${sym} موجود بالفعل`);
  }
});

bot.onText(/^\/قائمتي$/, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  const txt = list.length 
    ? `👀 <b>قائمة المراقبة:</b>\n` + list.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '📭 القائمة فارغة';
  bot.sendMessage(msg.chat.id, txt, { parse_mode: 'HTML' });
});

console.log('✅ Bot Running (Google Finance Edition)');