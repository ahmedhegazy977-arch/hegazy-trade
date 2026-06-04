const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const TOKEN = process.env.TOKEN;
if (!TOKEN) { console.error('❌ TOKEN missing!'); process.exit(1); }
const bot = new TelegramBot(TOKEN, { polling: true });

// 🗄️ التخزين في الذاكرة (يتصفى عند إعادة التشغيل)
const watchlist = new Map();
const priceAlerts = new Map();
const srLevels = new Map(); // { chatId: { SYMBOL: { support: [], resistance: [] } } }
const breakoutLog = new Set(); // تتبع الاختراقات اللي تم التنبيه عليها

// 📊 قائمة الأسهم الرئيسية للمسح
const EGX_LIST = [
  'COMI','EFID','ETEL','SWDY','HRHO','ESRS','PHDC','TMGH','ORWE','FWRY',
  'EKHO','EAST','OCDI','EKZN','MCDR','EGBN','AMOC','APPC','SKPC','ISPH',
  'AUTO','EAST','GBCO','HELI','MNHD','OBEL','OLFI','ORWE','PHCI','RMDA',
  'SODIC','TALM','TELS','UPFD','WUFA','YRGN','ZOD'
];

// ==================== 🌐 جلب البيانات ====================
async function getCurrentPrice(symbol) {
  const sym = symbol.toUpperCase();
  
  // 1. مباشر (أولوية)
  try {
    const { data } = await axios.get(`https://www.mubasher.info/markets/Egypt/stocks/${sym}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'ar-EG' },
      timeout: 7000
    });
    const $ = cheerio.load(data);
    let p = $('.stock-price__value').first().text().trim() || $('meta[property="og:price:amount"]').attr('content');
    const price = parseFloat(p?.replace(/,/g, ''));
    if (!isNaN(price)) {
      return { price, volume: parseInt($('.stock-price__volume').first().text().replace(/,/g,''))||0, source: 'Mubasher' };
    }
  } catch(e) {}

  // 2. ياهو (Fallback)
  const tickers = [`${sym}.CA`, `${sym}.CO`, sym];
  for(const t of tickers){
    try {
      const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?range=1d&interval=1m`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 7000
      });
      const meta = data.chart?.result?.[0]?.meta;
      if(meta?.regularMarketPrice) return { price: meta.regularMarketPrice, volume: meta.regularMarketVolume||0, source: 'Yahoo' };
    } catch(e) { continue; }
  }
  return null;
}

async function getHistoricalData(symbol) {
  const sym = symbol.toUpperCase();
  for(const t of [`${sym}.CA`, `${sym}.CO`, sym]){
    try {
      const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?range=1y&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
      });
      const quotes = data.chart?.result?.[0]?.indicators?.quote?.[0];
      if(quotes?.close?.length > 60){
        return {
          closes: quotes.close.filter(v=>v!==null),
          volumes: quotes.volume.filter(v=>v!==null),
          opens: quotes.open.filter(v=>v!==null)
        };
      }
    } catch(e) { continue; }
  }
  return null;
}

// ==================== 📐 المؤشرات الفنية ====================
const calc = {
  sma: (d,p) => d.length<p ? null : d.slice(-p).reduce((a,b)=>a+b,0)/p,
  ema: (d,p) => {
    if(d.length<p) return null;
    let k=2/(p+1), ema=d.slice(0,p).reduce((a,b)=>a+b,0)/p;
    for(let i=p;i<d.length;i++) ema=(d[i]-ema)*k+ema;
    return ema;
  },
  rsi: (c,p=14) => {
    if(c.length<p+1) return null;
    let g=0,l=0;
    for(let i=1;i<=p;i++){ const ch=c[i]-c[i-1]; ch>0?g+=ch:l-=ch; }
    let ag=g/p, al=l/p;
    for(let i=p+1;i<c.length;i++){
      const ch=c[i]-c[i-1];
      ch>0 ? (ag=(ag*(p-1)+ch)/p, al=(al*(p-1))/p) : (ag=(ag*(p-1))/p, al=(al*(p-1)-ch)/p);
    }
    return al===0 ? 100 : 100-(100/(1+ag/al));
  },
  macd: (c) => {
    const e12=calc.ema(c,12), e26=calc.ema(c,26);
    if(!e12||!e26) return null;
    const line=e12-e26, vals=[];
    for(let i=26;i<c.length;i++){
      const a=calc.ema(c.slice(0,i+1),12), b=calc.ema(c.slice(0,i+1),26);
      if(a&&b) vals.push(a-b);
    }
    const sig=calc.ema(vals,9);
    return { line, sig, hist: line-sig };
  }
};

// ====================  محرك الفلتر & التحليل ====================
function isMarketHours() {
  const h = new Date().getUTCHours() + 2;
  return h >= 10 && h < 14.5;
}

function getTag(source) {
  let tag = source === 'Mubasher' ? '✅ مباشر' : '⚠️ ياهو';
  if(source==='Yahoo' && isMarketHours()) tag += ' (متأخر 15د)';
  return tag;
}

async function analyze(symbol) {
  const [hist, curr] = await Promise.all([getHistoricalData(symbol), getCurrentPrice(symbol)]);
  if(!curr) return { ok:false, msg:`❌ فشل جلب ${symbol}` };
  
  const tag = getTag(curr.source);
  const res = { sym:symbol.toUpperCase(), price:curr.price, vol:curr.volume, tag, checks:{} };
  
  if(!hist) return { ok:true, data:res, partial:true, msg:`📊 ${res.sym}: ${res.price} جنيه [${tag}]\n البيانات التاريخية غير متاحة.` };

  const {closes, volumes, opens} = hist;
  res.checks.vol = { pass: calc.sma(volumes,20) && curr.vol >= calc.sma(volumes,20)*1.2, val:curr.vol, thr:Math.round(calc.sma(volumes,20)*1.2) };
  const lastO = opens[opens.length-1];
  const stab = lastO ? Math.abs(curr.price-lastO)/curr.price : null;
  res.checks.stab = { pass: stab!==null && stab<0.02, chg: stab?stab*100:null };
  res.checks.trend = { pass: calc.ema(closes,50) && calc.ema(closes,200) && curr.price>calc.ema(closes,50) && curr.price>calc.ema(closes,200), e50:calc.ema(closes,50), e200:calc.ema(closes,200) };
  res.checks.rsi = { pass: calc.rsi(closes)>=48 && calc.rsi(closes)<=55, val:calc.rsi(closes) };
  res.checks.macd = { pass: calc.macd(closes)?.hist !== null && Math.abs(calc.macd(closes).hist)<0.1, val:calc.macd(closes)?.hist };

  res.passed = Object.values(res.checks).every(x=>x.pass);
  res.score = Object.values(res.checks).filter(x=>x.pass).length;
  res.total = Object.keys(res.checks).length;
  return { ok:true, data:res };
}

// ====================  أوامر البوت ====================
bot.onText(/\/ابدأ/, msg => bot.sendMessage(msg.chat.id, 
  `🚀 *حجازي تريد برو v3*\n\n🔍 /فحص SYMBOL\n📋 /اضافة SYMBOL | /قائمة | /حذف SYMBOL\n📊 /فحص_الكل | /مسح_السوق\n /فرص_الشراء | /اختراقات\n📐 /دعم SYMBOL PRICE | /مقاومة SYMBOL PRICE\n🔔 /تنبيه SYMBOL فوق/تحت PRICE\n️ /حذف_مستوى SYMBOL\n\n💡数据来源: مباشر (أولوية) + ياهو (تاريخي)`, 
  {parse_mode:'Markdown'}));

const safeEdit = async (chatId, msgId, text, opts={}) => {
  try { await bot.editMessageText(text, {chat_id:chatId, message_id:msgId, parse_mode:'Markdown', ...opts}); }
  catch(e) { if(e.code!==400) console.error(e); }
};

bot.onText(/\/فحص\s+(\w+)/i, async (msg, m) => {
  const load = await bot.sendMessage(msg.chat.id, `🔍 جاري فحص ${m[1].toUpperCase()}...`);
  const r = await analyze(m[1]);
  if(!r.ok) return safeEdit(msg.chat.id, load.message_id, r.msg);
  if(r.partial) return safeEdit(msg.chat.id, load.message_id, r.msg);
  
  const d = r.data;
  let txt = `${d.passed?'🎉':'📊'} *${d.sym}* | ${d.price} جنيه [${d.tag}]\n`;
  txt += `📊 حجم: ${d.vol.toLocaleString()} ${d.checks.vol.thr?'(مطلوب:'+d.checks.vol.thr.toLocaleString()+')':''}\n`;
  txt += `📉 استقرار: ${d.checks.stab.chg?.toFixed(2)}% (<2%)\n`;
  txt += `📈 اتجاه: فوق EMA50(${d.checks.trend.e50?.toFixed(1)}) & EMA200(${d.checks.trend.e200?.toFixed(1)})\n`;
  txt += `🔄 RSI: ${d.checks.rsi.val?.toFixed(1)} (48-55)\n`;
  txt += `📊 MACD: ${d.checks.macd.val?.toFixed(3)} (≈0)\n\n`;
  txt += ` النتيجة: ${d.score}/${d.total}`;
  if(d.passed) txt += `\n🚀 *ممتاز! السهم يحقق الفلتر!*`;
  safeEdit(msg.chat.id, load.message_id, txt);
});

bot.onText(/\/اضافة\s+(\w+)/i, (msg, m) => {
  const s=m[1].toUpperCase(), c=msg.chat.id;
  if(!watchlist.has(c)) watchlist.set(c,[]);
  const l=watchlist.get(c);
  l.includes(s) ? bot.sendMessage(msg.chat.id, `️ ${s} موجود`) : (l.push(s), bot.sendMessage(msg.chat.id, `✅ أضيف ${s}`));
});

bot.onText(/\/قائمة/, msg => {
  const l=watchlist.get(msg.chat.id);
  bot.sendMessage(msg.chat.id, !l?.length ? ' فارغة' : '📋 *قائمة:*\n'+l.map((s,i)=>`${i+1}. *${s}*`).join('\n'), {parse_mode:'Markdown'});
});

bot.onText(/\/حذف\s+(\w+)/i, (msg, m) => {
  const s=m[1].toUpperCase(), l=watchlist.get(msg.chat.id);
  !l?.includes(s) ? bot.sendMessage(msg.chat.id, `⚠️ ${s} مش موجود`) : (l.splice(l.indexOf(s),1), bot.sendMessage(msg.chat.id, `✅ اتحذف ${s}`));
});

// 📐 دعم ومقاومة
const getSR = (chatId, sym) => srLevels.get(chatId)?.[sym] || {support:[], resistance:[]};
bot.onText(/\/(دعم|مقاومة)\s+(\w+)\s+([\d.]+)/i, (msg, m) => {
  const type = m[1], sym = m[2].toUpperCase(), price = parseFloat(m[3]);
  if(!srLevels.has(msg.chat.id)) srLevels.set(msg.chat.id, {});
  if(!srLevels.get(msg.chat.id)[sym]) srLevels.get(msg.chat.id)[sym] = {support:[], resistance:[]};
  srLevels.get(msg.chat.id)[sym][type==='دعم'?'support':'resistance'].push(price);
  bot.sendMessage(msg.chat.id, `✅ تم: ${type} ${sym} عند ${price}`, {parse_mode:'Markdown'});
});

bot.onText(/\/مستويات\s+(\w+)/i, (msg, m) => {
  const sr = getSR(msg.chat.id, m[1].toUpperCase());
  if(!sr.support.length && !sr.resistance.length) return bot.sendMessage(msg.chat.id, '📭 مفيش مستويات مسجلة');
  let txt = `📐 *مستويات ${m[1].toUpperCase()}:*\n🟢 دعم: ${sr.support.join(', ') || 'لا يوجد'}\n🔴 مقاومة: ${sr.resistance.join(', ') || 'لا يوجد'}`;
  bot.sendMessage(msg.chat.id, txt, {parse_mode:'Markdown'});
});

bot.onText(/\/حذف_مستوى\s+(\w+)/i, (msg, m) => {
  const sym = m[1].toUpperCase();
  if(srLevels.get(msg.chat.id)?.[sym]) delete srLevels.get(msg.chat.id)[sym];
  bot.sendMessage(msg.chat.id, `🗑️ تم حذف مستويات ${sym}`);
});

//  فحص الكل و المسح
bot.onText(/\/فحص_الكل/, async msg => {
  const l=watchlist.get(msg.chat.id);
  if(!l?.length) return bot.sendMessage(msg.chat.id, '📭 القائمة فارغة');
  const load = await bot.sendMessage(msg.chat.id, `🔍 بفحص ${l.length} سهم...`);
  let res=[];
  for(const s of l){ const r=await analyze(s); if(r.ok&&r.data) res.push(r.data); }
  res.sort((a,b)=>b.score-a.score);
  safeEdit(msg.chat.id, load.message_id, '📊 *النتائج:*\n'+res.map(d=>`${d.passed?'🎉':d.score>=4?'✅':'⚠️'} *${d.sym}*: ${d.score}/${d.total} | ${d.price} جنيه [${d.tag}]`).join('\n'));
});

bot.onText(/\/مسح_السوق/, async msg => {
  const load = await bot.sendMessage(msg.chat.id, ` جاري مسح ${EGX_LIST.length} سهم رئيسي... (قد يأخذ دقيقة)`);
  let buys=[], breaks=[], others=[];
  
  for(const sym of EGX_LIST){
    const r = await analyze(sym);
    if(!r.ok || r.partial) continue;
    const d = r.data;
    if(d.passed) buys.push(d);
    else if(d.score >= 4) others.push(d);
    
    // كشف اختراق بسيط (السعر فوق مقاومة ياهو التقريبية أو RSI>60 مع حجم)
    if(d.checks.rsi.val > 60 && d.checks.vol.pass && !breakoutLog.has(sym)){
      breaks.push(d);
      breakoutLog.add(sym);
    }
  }
  
  let txt = `🌍 *تقرير السوق (${EGX_LIST.length} سهم)*\n\n`;
  txt += ` *فرص شراء (${buys.length}):*\n${buys.map(d=>`• *${d.sym}* ${d.price} [${d.tag}]`).join('\n') || 'لا يوجد'}\n\n`;
  txt += `🚀 *اختراقات حديثة (${breaks.length}):*\n${breaks.map(d=>`• *${d.sym}* ${d.price} (RSI>${d.checks.rsi.val?.toFixed(0)})`).join('\n') || 'لا يوجد'}\n\n`;
  txt += `⚪ *متابعة (${others.length}):*\n${others.map(d=>`• *${d.sym}* ${d.price} (${d.score}/5)`).join('\n') || 'لا يوجد'}`;
  safeEdit(msg.chat.id, load.message_id, txt);
});

bot.onText(/\/فرص_الشراء/, async msg => {
  const load = await bot.sendMessage(msg.chat.id, '🔍 أبحث عن فرص شراء حالياً...');
  let found=[];
  for(const sym of EGX_LIST){
    const r=await analyze(sym);
    if(r.ok && !r.partial && r.data.passed) found.push(r.data);
  }
  safeEdit(msg.chat.id, load.message_id, found.length ? 
    `🎯 *فرص شراء نشطة:*\n`+found.map(d=>`• *${d.sym}* | ${d.price} جنيه [${d.tag}]`).join('\n') : '😴 مفيش أسهم محققة الفلتر دلوقتي.');
});

bot.onText(/\/اختراقات/, async msg => {
  const load = await bot.sendMessage(msg.chat.id, '🚀 أبحث عن اختراقات حديثة...');
  let found=[];
  for(const sym of EGX_LIST){
    const r=await analyze(sym);
    if(r.ok && !r.partial && r.data.checks.rsi.val > 60 && r.data.checks.vol.pass) found.push(r.data);
  }
  safeEdit(msg.chat.id, load.message_id, found.length ? 
    `🚀 *أسهم في زخم/اختراق:*\n`+found.map(d=>`• *${d.sym}* | ${d.price} | RSI:${d.checks.rsi.val?.toFixed(1)}`).join('\n') : '📉 مفيش اختراقات واضحة دلوقتي.');
});

// 🔔 تنبيهات سعر
bot.onText(/\/تنبيه\s+(\w+)\s+(فوق|تحت)\s+([\d.]+)/i, (msg, m) => {
  const c=msg.chat.id; if(!priceAlerts.has(c)) priceAlerts.set(c,[]);
  priceAlerts.get(c).push({sym:m[1].toUpperCase(), type:m[2], price:parseFloat(m[3])});
  bot.sendMessage(msg.chat.id, `✅ تم: ${m[1].toUpperCase()} ${m[2]} ${m[3]}`, {parse_mode:'Markdown'});
});

bot.onText(/\/تنبيهات/, msg => {
  const l=priceAlerts.get(msg.chat.id);
  bot.sendMessage(msg.chat.id, !l?.length ? '📭 مفيش تنبيهات' : '🔔 *تنبيهات:*\n'+l.map((a,i)=>`${i+1}. *${a.sym}* ${a.type} ${a.price}`).join('\n'), {parse_mode:'Markdown'});
});

// ==================== ⏱️ الفحص الدوري (كل ساعة) ====================
setInterval(async () => {
  console.log('🔄 فحص دوري...');
  
  // 1. فحص قائمة المراقبة
  for(const [c, list] of watchlist){
    for(const s of list){
      const r=await analyze(s);
      if(r.ok && r.data && r.data.passed) bot.sendMessage(c, ` *${r.data.sym} حقق الفلتر!*\n💰 ${r.data.price} جنيه [${r.data.tag}]`, {parse_mode:'Markdown'});
    }
  }
  
  // 2. فحص الدعم والمقاومة
  for(const [c, symbols] of srLevels){
    for(const [sym, levels] of Object.entries(symbols)){
      const curr = await getCurrentPrice(sym);
      if(!curr) continue;
      const p = curr.price;
      
      // دعم
      for(const sp of levels.support){
        if(p <= sp + 0.05 && p >= sp - 0.05) {
          bot.sendMessage(c, `🟢 *${sym} لمس الدعم!*\n💰 ${p} جنيه ≈ ${sp}`, {parse_mode:'Markdown'});
        }
      }
      // مقاومة
      for(const rp of levels.resistance){
        if(p >= rp - 0.05 && p <= rp + 0.05) {
          bot.sendMessage(c, `🔴 *${sym} لمس المقاومة!*\n💰 ${p} جنيه ≈ ${rp}`, {parse_mode:'Markdown'});
        }
      }
    }
  }

  // 3. تنبيهات السعر
  for(const [c, alerts] of priceAlerts){
    for(let i=alerts.length-1; i>=0; i--){
      const a = alerts[i];
      const curr = await getCurrentPrice(a.sym);
      if(!curr) continue;
      const hit = (a.type==='فوق' && curr.price >= a.price) || (a.type==='تحت' && curr.price <= a.price);
      if(hit){
        bot.sendMessage(c, ` *تنبيه ${a.sym}*\n💰 وصل ${curr.price} (${a.type} ${a.price})`, {parse_mode:'Markdown'});
        alerts.splice(i,1); // شيل التنبيه بعد ما يشتغل
      }
    }
  }
}, 3600000);

console.log('✅ Hegazy Trade Pro v3.0 Running | Hybrid Engine Active');