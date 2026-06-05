const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const API_KEY = process.env.ALPHA_API_KEY;
const bot = new TelegramBot(TOKEN, { polling: true });

// الأسهم المصرية في Alpha Vantage (بتستخدم .CA)
const STOCKS = {
  'EFID': 'EFID.CAI',
  'COMI': 'COMI.CAI',
  'ETEL': 'ETEL.CAI',
  'SWDY': 'SWDY.CAI',
  'HRHO': 'HRHO.CAI',
  'ESRS': 'ESRS.CAI',
  'PHDC': 'PHDC.CAI',
  'TMGH': 'TMGH.CAI',
  'EAST': 'EAST.CAI',
  'EGBN': 'EGBN.CAI',
  'OCDI': 'OCDI.CAI',
  'ISPH': 'ISPH.CAI',
  'MNHD': 'MNHD.CAI',
  'OBEL': 'OBEL.CAI',
  'SODIC': 'SODIC.CAI'
};

const watchlists = new Map();

async function getPrice(sym) {
  const ticker = STOCKS[sym.toUpperCase()];
  if (!ticker) return { err: '❌ الرمز غير مدعوم' };

  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${API_KEY}`;
    const res = await axios.get(url, { timeout: 10000 });
    
    const quote = res.data['Global Quote'];
    if (!quote || Object.keys(quote).length === 0) {
      return { err: '❌ لا توجد بيانات. تأكد من الرمز أو رصيد API' };
    }

    return {
      ok: true,
      data: {
        symbol: sym.toUpperCase(),
        price: parseFloat(quote['05. price'] || 0),
        change: parseFloat(quote['09. change'] || 0),
        changePercent: quote['10. change percent'] || '0%',
        high: parseFloat(quote['03. high'] || 0),
        low: parseFloat(quote['04. low'] || 0),
        volume: parseInt(quote['06. volume'] || 0)
      }
    };
  } catch (e) {
    return { err: `❌ خطأ: ${e.message}` };
  }
}

bot.onText(/^\/(start|ابدأ)$/, (msg) => {
  bot.sendMessage(msg.chat.id, ` <b>بوت حجازي تريد</b>\n\n/سعر SYMBOL - سعر السهم\n/اضافة SYMBOL - للمراقبة\n/قائمتي - عرض القائمة\n\nمثال: <code>/سعر EFID</code>`, { parse_mode: 'HTML' });
});

bot.onText(/^\/سعر\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, `⏳ ${sym}...`);
  const r = await getPrice(sym);
  
  if (r.err) return bot.editMessageText(r.err, { chat_id: msg.chat.id, message_id: load.message_id });
  
  const d = r.data;
  const icon = d.change >= 0 ? '📈' : '📉';
  const txt = `📊 <b>${d.symbol}</b>\n💰 السعر: <b>${d.price}</b> جنيه\n${icon} التغيير: ${d.change} (${d.changePercent})\n📈 أعلى: ${d.high}\n📉 أقل: ${d.low}\n📊 حجم: ${d.volume.toLocaleString()}`;
  
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'HTML' });
});

bot.onText(/^\/اضافة\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  const cid = msg.chat.id;
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, '❌ رمز غير مدعوم');
  if (!watchlists.has(cid)) watchlists.set(cid, []);
  const list = watchlists.get(cid);
  if (!list.includes(sym)) {
    list.push(sym);
    bot.sendMessage(msg.chat.id, `✅ أضيف ${sym}`);
  } else {
    bot.sendMessage(msg.chat.id, '⚠️ موجود');
  }
});

bot.onText(/^\/قائمتي$/, (msg) => {
  const list = watchlists.get(msg.chat.id) || [];
  bot.sendMessage(msg.chat.id, list.length ? `👀 <b>مراقبتك:</b>\n${list.map((s,i)=>`${i+1}. ${s}`).join('\n')}` : '📭 فارغة', { parse_mode: 'HTML' });
});

console.log('✅ Bot Running - Alpha Vantage');