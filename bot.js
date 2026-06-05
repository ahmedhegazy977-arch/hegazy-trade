const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const API_KEY = process.env.TWELVE_API_KEY;
const bot = new TelegramBot(TOKEN, { polling: true });

// خريطة الأسهم المصرية في Twelve Data
const STOCKS = {
  'EFID': 'EFID.EGX', 'COMI': 'COMI.EGX', 'ETEL': 'ETEL.EGX',
  'SWDY': 'SWDY.EGX', 'HRHO': 'HRHO.EGX', 'ESRS': 'ESRS.EGX',
  'PHDC': 'PHDC.EGX', 'TMGH': 'TMGH.EGX', 'EAST': 'EAST.EGX',
  'EGBN': 'EGBN.EGX', 'OCDI': 'OCDI.EGX', 'ISPH': 'ISPH.EGX',
  'MNHD': 'MNHD.EGX', 'OBEL': 'OBEL.EGX', 'SODIC': 'SODIC.EGX'
};

const watchlists = new Map();

// دالة جلب البيانات
async function fetchStock(sym) {
  const ticker = STOCKS[sym.toUpperCase()];
  if (!ticker) return { err: '❌ الرمز غير مدعوم. جرب: EFID, COMI, ETEL, SWDY, HRHO, ESRS, PHDC, TMGH, EAST, EGBN, OCDI, ISPH, MNHD, OBEL, SODIC' };

  try {
    const res = await axios.get(`https://api.twelvedata.com/quote?symbol=${ticker}&apikey=${API_KEY}`, { timeout: 10000 });
    if (res.data.price) return { ok: true, data: res.data };
    return { err: '❌ فشل في جلب البيانات. تأكد من الرمز أو رصيد الـ API.' };
  } catch (e) {
    return { err: `❌ خطأ في الاتصال: ${e.message}` };
  }
}

// الأوامر
bot.onText(/^\/(start|ابدأ)$/, (msg) => {
  bot.sendMessage(msg.chat.id, ` <b>أهلاً بيك في بوت حجازي تريد!</b>\n\n📊 <b>الأوامر:</b>\n/sعر SYMBOL - سعر السهم الحالي\n/اضافة SYMBOL - إضافة للمراقبة\n/قائمتي - عرض مراقبتك\n\n💡 مثال: <code>/سعر EFID</code>`, { parse_mode: 'HTML' });
});

bot.onText(/^\/سعر\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, `⏳ جاري البحث عن ${sym}...`);
  const r = await fetchStock(sym);
  if (r.err) return bot.editMessageText(r.err, { chat_id: msg.chat.id, message_id: load.message_id });

  const d = r.data;
  const ch = parseFloat(d.change || 0);
  const icon = ch >= 0 ? '📈' : '';
  const txt = `📊 <b>${d.symbol.replace('.EGX', '')}</b>\n💰 السعر: <b>${d.price}</b> جنيه\n${icon} التغيير: ${ch} (${d.change_percent || 0}%)\n📈 أعلى: ${d.high} | 📉 أقل: ${d.low}\n📊 الحجم: ${d.volume || 'N/A'}\n آخر تحديث: ${d.timestamp || new Date().toLocaleTimeString()}`;
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'HTML' });
});

bot.onText(/^\/اضافة\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  const cid = msg.chat.id;
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, '❌ الرمز غير مدعوم');
  if (!watchlists.has(cid)) watchlists.set(cid, []);
  const list = watchlists.get(cid);
  if (!list.includes(sym)) { list.push(sym); bot.sendMessage(msg.chat.id, `✅ تمت إضافة ${sym} للمراقبة`); }
  else bot.sendMessage(msg.chat.id, `⚠️ ${sym} موجود بالفعل`);
});

bot.onText(/^\/قائمتي$/, (msg) => {
  const list = watchlists.get(msg.chat.id) || [];
  bot.sendMessage(msg.chat.id, list.length ? `👀 <b>قائمة مراقبتك:</b>\n${list.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '📭 القائمة فارغة', { parse_mode: 'HTML' });
});

console.log('✅ Bot Running (Stable v1.0)');