const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const watchlist = new Map();

// رموز Yahoo Finance للأسهم المصرية (.CA)
const STOCKS = {
  'EFID': 'EFID.CA',
  'COMI': 'COMI.CA',
  'ETEL': 'ETEL.CA',
  'SWDY': 'SWDY.CA',
  'HRHO': 'HRHO.CA',
  'ESRS': 'ESRS.CA',
  'PHDC': 'PHDC.CA',
  'TMGH': 'TMGH.CA',
  'EAST': 'EAST.CA',
  'EGBN': 'EGBN.CA',
  'OCDI': 'OCDI.CA',
  'ISPH': 'ISPH.CA',
  'MNHD': 'MNHD.CA',
  'OBEL': 'OBEL.CA',
  'SODIC': 'SODIC.CA'
};

async function getPrice(symbol) {
  const ticker = STOCKS[symbol.toUpperCase()];
  if (!ticker) return { err: '❌ الرمز غير مدعوم' };

  try {
    // رابط Yahoo Finance المباشر
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1m`;
    
    const { data } = await axios.get(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const result = data.chart?.result?.[0];
    if (!result || !result.meta) {
      return { err: '❌ لا توجد بيانات لهذا السهم' };
    }

    const meta = result.meta;
    const currentPrice = meta.regularMarketPrice;
    const prevClose = meta.previousClose;
    const change = currentPrice - prevClose;
    const changePercent = (change / prevClose) * 100;

    return {
      ok: true,
      data: {
        symbol: symbol.toUpperCase(),
        price: currentPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2) + '%',
        currency: meta.currency || 'EGP',
        source: 'Yahoo Finance'
      }
    };
  } catch (e) {
    return { err: `❌ خطأ: ${e.message}` };
  }
}

// الأوامر
bot.onText(/^\/(start|ابدأ)$/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    ` <b>بوت حجازي تريد (Yahoo)</b>\n\n` +
    `/سعر SYMBOL - سعر السهم\n` +
    `/اضافة SYMBOL - للمراقبة\n` +
    `/قائمتي - عرض القائمة\n\n` +
    `مثال: <code>/سعر EFID</code>`, 
    { parse_mode: 'HTML' }
  );
});

bot.onText(/^\/سعر\s+(\w+)$/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, `⏳ ${sym}...`);
  const r = await getPrice(sym);

  if (r.err) return bot.editMessageText(r.err, { chat_id: msg.chat.id, message_id: load.message_id });

  const d = r.data;
  const icon = parseFloat(d.change) >= 0 ? '📈' : '📉';
  const txt = `📊 <b>${d.symbol}</b>\n` +
              `💰 السعر: <b>${d.price}</b> ${d.currency}\n` +
              `${icon} التغيير: ${d.change} (${d.changePercent})\n` +
              `📡 المصدر: ${d.source}`;

  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id, parse_mode: 'HTML' });
});

bot.onText(/^\/اضافة\s+(\w+)$/i, (msg, match) => {
  const sym = match[1].toUpperCase();
  const cid = msg.chat.id;
  if (!STOCKS[sym]) return bot.sendMessage(msg.chat.id, '❌ رمز غير مدعوم');
  
  if (!watchlist.has(cid)) watchlist.set(cid, []);
  const list = watchlist.get(cid);
  
  if (!list.includes(sym)) {
    list.push(sym);
    bot.sendMessage(msg.chat.id, `✅ أضيف ${sym}`);
  } else {
    bot.sendMessage(msg.chat.id, '⚠️ موجود');
  }
});

bot.onText(/^\/قائمتي$/, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  bot.sendMessage(msg.chat.id, 
    list.length ? `👀 <b>مراقبتك:</b>\n${list.map((s,i)=>`${i+1}. ${s}`).join('\n')}` : '📭 فارغة', 
    { parse_mode: 'HTML' }
  );
});

console.log('✅ Bot Running (Yahoo Finance Direct)');