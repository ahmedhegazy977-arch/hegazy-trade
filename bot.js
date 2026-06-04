const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const watchlist = new Map();
const alerts = new Map();

// ==================== جلب البيانات ====================

async function getHistoricalData(symbol) {
  try {
    const ticker = `${symbol.toUpperCase()}.CA`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d`;
    
    const { data } = await axios.get(url, { 
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000 
    });
    
    if (!data.chart?.result?.length) return null;
    
    const quotes = data.chart.result[0].indicators.quote[0];
    const closes = quotes.close?.filter(c => c !== null) || [];
    const volumes = quotes.volume?.filter(v => v !== null) || [];
    const opens = quotes.open?.filter(o => o !== null) || [];
    
    return closes.length > 50 ? { closes, volumes, opens } : null;
  } catch (e) {
    console.error(`Yahoo Historical Error [${symbol}]:`, e.message);
    return null;
  }
}

async function getCurrentPrice(symbol) {
  // 1. محاولة Mubasher
  try {
    const url = `https://www.mubasher.info/markets/Egypt/stocks/${symbol.toUpperCase()}`;
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://www.mubasher.info/',
        'Accept-Language': 'ar-EG,en;q=0.9'
      },
      timeout: 10000
    });
    const $ = cheerio.load(data);
    
    // عدة selectors احتياطية
    let p = $('.stock-price__value').first().text().trim() || 
            $('.price').first().text().trim() || 
            $('meta[property="og:price:amount"]').attr('content');
            
    const price = parseFloat(p?.replace(/,/g, ''));
    if (!isNaN(price)) {
      const v = parseInt($('.stock-price__volume').first().text().trim().replace(/,/g, '')) || 0;
      console.log(`✅ Mubasher OK [${symbol}]: ${price}`);
      return { price, volume: v, source: 'Mubasher' };
    }
  } catch (e) {
    console.warn(`⚠️ Mubasher failed [${symbol}], fallback to Yahoo...`);
  }

  // 2. Fallback لـ Yahoo Finance (دقيق ومجاني)
  try {
    const ticker = `${symbol.toUpperCase()}.CA`;
    const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1m`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    const meta = data.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice) {
      const price = meta.regularMarketPrice;
      const volume = meta.regularMarketVolume || 0;
      console.log(`✅ Yahoo Fallback OK [${symbol}]: ${price}`);
      return { price, volume, source: 'Yahoo' };
    }
  } catch (e) {
    console.error(`❌ Yahoo Fallback Error [${symbol}]:`, e.message);
  }

  return null;
}

// ==================== الحسابات الفنية ====================

function calcSMA(d, p) { return d.length < p ? null : d.slice(-p).reduce((a,b)=>a+b,0)/p; }
function calcEMA(d, p) {
  if (d.length < p) return null;
  const k = 2/(p+1);
  let ema = d.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p; i<d.length; i++) ema = (d[i]-ema)*k + ema;
  return ema;
}
function calcRSI(c, p=14) {
  if(c.length < p+1) return null;
  let g=0, l=0;
  for(let i=1; i<=p; i++) { const ch=c[i]-c[i-1]; ch>0?g+=ch:l-=ch; }
  let ag=g/p, al=l/p;
  for(let i=p+1; i<c.length; i++) {
    const ch=c[i]-c[i-1];
    ch>0 ? (ag=(ag*(p-1)+ch)/p, al=(al*(p-1))/p) : (ag=(ag*(p-1))/p, al=(al*(p-1)-ch)/p);
  }
  return al===0 ? 100 : 100-(100/(1+ag/al));
}
function calcMACD(c) {
  const e12=calcEMA(c,12), e26=calcEMA(c,26);
  if(!e12||!e26) return null;
  const line=e12-e26;
  const vals=[];
  for(let i=26; i<c.length; i++) {
    const a=calcEMA(c.slice(0,i+1),12), b=calcEMA(c.slice(0,i+1),26);
    if(a&&b) vals.push(a-b);
  }
  const sig=calcEMA(vals,9);
  return { line, sig, hist: line-sig };
}

// ==================== تطبيق الفلتر ====================

async function applyFilter(symbol) {
  const [hist, curr] = await Promise.all([getHistoricalData(symbol), getCurrentPrice(symbol)]);
  
  if (!curr) return { success: false, message: `❌ فشل في جلب بيانات ${symbol}` };
  
  const res = { symbol: symbol.toUpperCase(), price: curr.price, volume: curr.volume, source: curr.source, checks: {} };
  
  if (!hist) {
    return { success: true, data: res, partial: true, message: `⚠️ ${symbol}: ${curr.price} جنيه (${curr.source})\nالبيانات التاريخية غير متاحة حالياً.` };
  }
  
  const { closes, volumes, opens } = hist;
  const smaV = calcSMA(volumes, 20);
  const ema50 = calcEMA(closes, 50), ema200 = calcEMA(closes, 200);
  const rsi = calcRSI(closes), macd = calcMACD(closes);
  
  res.checks.volume = { pass: smaV && curr.volume >= smaV*1.2, val: curr.volume, thr: smaV?Math.round(smaV*1.2):null };
  const lastO = opens[opens.length-1];
  const stab = lastO ? Math.abs(curr.price-lastO)/curr.price : null;
  res.checks.stability = { pass: stab!==null && stab<0.02, chg: stab?stab*100:null };
  res.checks.trend = { pass: ema50&&ema200&&curr.price>ema50&&curr.price>ema200, p:curr.price, e50:ema50, e200:ema200 };
  res.checks.rsi = { pass: rsi!==null && rsi>=48 && rsi<=55, val: rsi };
  res.checks.macd = { pass: macd && Math.abs(macd.hist)<0.1, val: macd?.hist };
  
  res.passed = Object.values(res.checks).every(x=>x.pass);
  res.passedCount = Object.values(res.checks).filter(x=>x.pass).length;
  res.totalChecks = Object.keys(res.checks).length;
  
  return { success: true, data: res };
}

// ==================== الأوامر ====================

bot.onText(/\/ابدأ/, msg => bot.sendMessage(msg.chat.id, 
  `👋 *أهلاً بك في بوت حجازي للتداول!*\n\n🔍 /فحص SYMBOL\n📋 /اضافة SYMBOL | /قائمة | /حذف SYMBOL | /فحص_الكل\n🔔 /تنبيه SYMBOL فوق/تحت سعر\n📊数据来源: Mubasher + Yahoo Finance`, 
  { parse_mode: 'Markdown' }));

bot.onText(/\/فحص\s+(\w+)/i, async (msg, match) => {
  const sym = match[1].toUpperCase();
  const load = await bot.sendMessage(msg.chat.id, `🔍 جاري فحص ${sym}...`);
  const r = await applyFilter(sym);
  
  if (!r.success) { bot.editMessageText(r.message, { chat_id: msg.chat.id, message_id: load.message_id }); return; }
  if (r.partial) { bot.editMessageText(r.message, { chat_id: msg.chat.id, message_id: load.message_id, parse_mode:'Markdown' }); return; }
  
  const d = r.data;
  let txt = `${d.passed?'🎉':''} *${d.symbol}* | ${d.price} جنيه (${d.source})\n حجم: ${d.volume.toLocaleString()}\n\n`;
  const v=d.checks.volume; txt+=`${v.pass?'✅':'❌'} حجم: ${v.val.toLocaleString()} ${v.thr?'(مطلوب:'+v.thr.toLocaleString()+')':''}\n`;
  const s=d.checks.stability; txt+=`${s.pass?'✅':'❌'} استقرار: ${s.chg?s.chg.toFixed(2)+'%':'N/A'} (<2%)\n`;
  const t=d.checks.trend; txt+=`${t.pass?'✅':'❌'} اتجاه: فوق EMA50(${t.e50?.toFixed(1)}) & EMA200(${t.e200?.toFixed(1)})\n`;
  const rs=d.checks.rsi; txt+=`${rs.pass?'✅':'❌'} RSI: ${rs.val?.toFixed(1)} (48-55)\n`;
  const m=d.checks.macd; txt+=`${m.pass?'✅':'❌'} MACD: ${m.val?.toFixed(3)} (≈0)\n`;
  txt+=`\n📊 النتيجة: ${d.passedCount}/${d.totalChecks}`;
  if(d.passed) txt+=`\n🚀 *ممتاز! السهم يحقق الفلتر!*`;
  
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: load.message_id, parse_mode:'Markdown' });
});

bot.onText(/\/اضافة\s+(\w+)/i, (msg, m) => {
  const s=m[1].toUpperCase(), c=msg.chat.id;
  if(!watchlist.has(c)) watchlist.set(c,[]);
  const l=watchlist.get(c);
  l.includes(s) ? bot.sendMessage(msg.chat.id, `⚠️ ${s} موجود`) : (l.push(s), bot.sendMessage(msg.chat.id, `✅ أضيف ${s}`));
});

bot.onText(/\/قائمة/, msg => {
  const l=watchlist.get(msg.chat.id);
  bot.sendMessage(msg.chat.id, !l||!l.length ? '📭 فارغة' : '📋 *قائمة:*\n'+l.map((s,i)=>`${i+1}. *${s}*`).join('\n'), {parse_mode:'Markdown'});
});

bot.onText(/\/حذف\s+(\w+)/i, (msg, m) => {
  const s=m[1].toUpperCase(), l=watchlist.get(msg.chat.id);
  !l||!l.includes(s) ? bot.sendMessage(msg.chat.id, `⚠️ ${s} مش موجود`) : (l.splice(l.indexOf(s),1), bot.sendMessage(msg.chat.id, `✅ اتحذف ${s}`));
});

bot.onText(/\/فحص_الكل/, async msg => {
  const l=watchlist.get(msg.chat.id);
  if(!l||!l.length) return bot.sendMessage(msg.chat.id, '📭 فارغة');
  const load = await bot.sendMessage(msg.chat.id, `🔍 بفحص ${l.length} سهم...`);
  let res=[];
  for(const s of l) { const r=await applyFilter(s); if(r.success&&r.data) res.push(r.data); }
  res.sort((a,b)=>(b.passedCount||0)-(a.passedCount||0));
  bot.editMessageText('📊 *النتائج:*\n\n'+res.map(d=>`${d.passed?'🎉':d.passedCount>=4?'✅':'⚠️'} *${d.symbol}*: ${d.passedCount||0}/${d.totalChecks||0} | ${d.price} جنيه`).join('\n'), { chat_id:msg.chat.id, message_id:load.message_id, parse_mode:'Markdown' });
});

bot.onText(/\/تنبيه\s+(\w+)\s+(فوق|تحت)\s+([\d.]+)/i, (msg, m) => {
  const c=msg.chat.id; if(!alerts.has(c)) alerts.set(c,[]);
  alerts.get(c).push({sym:m[1].toUpperCase(), type:m[2], price:parseFloat(m[3])});
  bot.sendMessage(msg.chat.id, `✅ تم: ${m[1].toUpperCase()} ${m[2]} ${m[3]}`, {parse_mode:'Markdown'});
});

bot.onText(/\/تنبيهات/, msg => {
  const l=alerts.get(msg.chat.id);
  bot.sendMessage(msg.chat.id, !l||!l.length ? ' مفيش' : ' *تنبيهات:*\n'+l.map((a,i)=>`${i+1}. *${a.sym}* ${a.type} ${a.price}`).join('\n'), {parse_mode:'Markdown'});
});

setInterval(async () => {
  for(const [c, list] of watchlist) {
    for(const s of list) {
      const r=await applyFilter(s);
      if(r.success&&r.data&&r.data.passed) bot.sendMessage(c, `🚨 *${r.data.symbol} حقق الفلتر!*\n💰 ${r.data.price} جنيه`, {parse_mode:'Markdown'});
    }
  }
}, 3600000);

console.log('✅ Bot Running | Hybrid Mode Active');