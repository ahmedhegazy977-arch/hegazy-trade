const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const watchlist = new Map();

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
  if (!ticker) return { err: 'Symbol not supported' };

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1m`;
    
    const { data } = await axios.get(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const result = data.chart?.result?.[0];
    if (!result || !result.meta) {
      return { err: 'No data available' };
    }

    const meta = result.meta;
    const currentPrice = meta.regularMarketPrice || 0;
    
    //  Fallback آمن لو previousClose مش موجود
    const prevClose = meta.previousClose || meta.regularMarketPreviousClose || meta.chartPreviousClose || currentPrice;
    
    const change = currentPrice - prevClose;
    const changePercent = prevClose ? ((change / prevClose) * 100).toFixed(2) + '%' : '0.00%';

    return {
      ok: true,
      data: {
        symbol: symbol.toUpperCase(),
        price: currentPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent,
        currency: meta.currency || 'EGP'
      }
    };
  } catch (e) {
    return { err: 'Connection error: ' + e.message };
  }
}

// Commands
bot.onText(/^\/start$/i, (msg) => {
  const text = ' Hegazy Trade Bot Active!\n\n' +
               '📊 Commands:\n' +
               '/price SYMBOL - Get live price\n' +
               '/add SYMBOL - Add to watchlist\n' +
               '/list - View watchlist\n\n' +
               '💡 Example: /price EFID';
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/^\/price\s+(\w+)$/i, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  const loadMsg = await bot.sendMessage(msg.chat.id, '⏳ Loading...');
  
  const result = await getPrice(symbol);
  
  if (result.err) {
    return bot.editMessageText(`❌ ${result.err}`, {
      chat_id: msg.chat.id,
      message_id: loadMsg.message_id
    });
  }

  const d = result.data;
  const icon = parseFloat(d.change) >= 0 ? '📈' : '📉';
  
  const text = `📊 *${d.symbol}*\n` +
               `💰 Price: *${d.price}* ${d.currency}\n` +
               `${icon} Change: *${d.change}* (${d.changePercent})\n` +
               `🌐 Source: Yahoo Finance`;

  bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: loadMsg.message_id,
    parse_mode: 'Markdown'
  });
});

bot.onText(/^\/add\s+(\w+)$/i, (msg, match) => {
  const symbol = match[1].toUpperCase();
  const chatId = msg.chat.id;
  
  if (!STOCKS[symbol]) {
    return bot.sendMessage(msg.chat.id, '❌ Symbol not supported');
  }
  
  if (!watchlist.has(chatId)) watchlist.set(chatId, []);
  const list = watchlist.get(chatId);
  
  if (!list.includes(symbol)) {
    list.push(symbol);
    bot.sendMessage(msg.chat.id, `✅ Added ${symbol} to watchlist`);
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ ${symbol} already exists`);
  }
});

bot.onText(/^\/list$/i, (msg) => {
  const list = watchlist.get(msg.chat.id) || [];
  if (list.length === 0) return bot.sendMessage(msg.chat.id, '📭 Watchlist is empty');
  
  const text = ' *Your Watchlist:*\n' + 
               list.map((s, i) => `${i + 1}. *${s}*`).join('\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

console.log('✅ Bot Started - Stable v1.1 (NaN Fixed)');