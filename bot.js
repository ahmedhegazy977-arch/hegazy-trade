const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const watchlist = new Map();
const priceAlerts = new Map();
const srLevels = new Map();

const EGX_LIST = ['COMI','EFID','ETEL','SWDY','HRHO','ESRS','PHDC','TMGH','ORWE','FWRY','EKHO','EAST','OCDI','EKZN','MCDR','EGBN','AMOC','APPC','SKPC','ISPH','AUTO','GBCO','HELI','MNHD','OBEL','OLFI','PHCI','RMDA','SODIC','TALM','TELS','UPFD','WUFA','YRGN','ZOD'];

async function getCurrentPrice(symbol) {
  const sym = symbol.toUpperCase();
  try {
    const { data } = await axios.get(`https://www.mubasher.info/markets/Egypt/stocks/${sym}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 7000
    });
    const $ = cheerio.load(data);
    let p = $('.stock-price__value').first().text().trim();
    const price = parseFloat(p.replace(/,/g, ''));
    if (!isNaN(price)) {
      return { price, volume: parseInt($('.stock-price__volume').first().text().replace(/,/g,''))||0, source: 'Mubasher' };
    }
  } catch(e) {}
  
  for(const t of [`${sym}.CA`, `${sym}.CO`, sym]){
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
  for(const t of [`${symbol.toUpperCase()}.CA`, `${symbol.toUpperCase()}.CO`, symbol.toUpperCase()]){
    try {
      const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?range=1y&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
      });
      const q = data.chart?.result?.[0]?.indicators?.quote?.[0];
      if(q?.close?.length > 60) return { closes: q.close.filter(v=>v), volumes: q.volume.filter(v=>v), opens: q.open.filter(v=>v) };
    } catch(e) { continue; }
  }
  return null;
}

const calc = {
  sma: (d,p) => d.length<p ? null : d.slice(-p).reduce((a,b)=>a+b,0)/p,
  ema: (d,p) => { if(d.length<p) return null; let k=2/(p+1), ema=d.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<d.length;i++) ema=(d[i]-ema)*k+ema; return ema; },
  rsi: (c,p=14) => { if(c.length<p+1) return null; let g=0,l=0; for(let i=1;i<=p;i++){ const ch=c[i]-c[i-1]; ch>0?g+=ch:l-=ch; } let ag=g/p, al=l/p; for(let i=p+1;i<c.length;i++){ const ch=c[i]-c[i-1]; ch>0?(ag=(ag*(p-1)+ch)/p,al=(al*(p-1))/p):(ag=(ag*(p-1))/p,al=(al*(p-1)-ch)/p); } return al===0?100:100-(100/(1+ag/al)); },
  macd: (c) => { const e12=calc.ema(c,12), e26=calc.ema(c,26); if(!e12||!e26) return null; const line=e12-e26, vals=[]; for(let i=26;i<c.length;i++){ const a=calc.ema(c.slice(0,i+1),12), b=calc.ema(c.slice(0,i+1),26); if(a&&b) vals.push(a-b); } const sig=calc.ema(vals,9); return { line, sig, hist: line-sig }; }
};

async function analyze(symbol) {
  const [hist, curr] = await Promise.all([getHistoricalData(symbol), getCurrentPrice(symbol)]);
  if(!curr) return { ok:false, msg:`❌ فشل جلب ${symbol}` };
  const tag = curr.source==='Mubasher'?'✅ مباشر':'⚠️ ياهو';
  const res = { sym:symbol.toUpperCase(), price:curr.price, vol:curr.volume, tag, checks:{} };
  if(!hist) return { ok:true, data:res, partial:true, msg:`📊 ${res.sym}: ${res.price} جنيه [${tag}]` };
  
  const {closes, volumes, opens} = hist;
  const smaV = calc.sma(volumes,20);
  res.checks.vol = { pass: smaV && curr.vol >= smaV*1.2, val:curr.vol, thr:Math.round(smaV*1.2) };
  const lastO = opens[opens.length-1];
  const stab = lastO ? Math.abs(curr.price-lastO)/curr.price : null;
  res.checks.stab = { pass: stab!==null && stab<0.02, chg: stab?stab*100:null };
  const e50=calc.ema(closes,50), e200=calc.ema(closes,200);
  res.checks.trend = { pass: e50&&e200&&curr.price>e50&&curr.price>e200, e50, e200 };
  const rsiVal = calc.rsi(closes);
  res.checks.rsi = { pass: rsiVal>=48 && rsiVal<=55, val:rsiVal };
  const macdVal = calc.macd(closes);
  res.checks.macd = { pass: macdVal && Math.abs(macdVal.hist)<0.1, val:macdVal?.hist };
  
  res.passed = Object.values(res.checks).every(x=>x.pass);
  res.score = Object.values(res.checks).filter(x=>x.pass).length;
  res.total = Object.keys(res.checks).length;
  return { ok:true, data:res };
}

bot.onText(/\/ابدأ/, msg => bot.sendMessage(msg.chat.id, `🚀 *حجازي تريد برو*\n\n🔍 /فحص SYMBOL\n📋 /اضافة | /قائمة | /حذف\n📊 /فحص_الكل | /مسح_السوق\n🎯 /فرص_الشراء | /اختراقات\n📐 /دعم SYMBOL PRICE | /مقاومة SYMBOL PRICE\n🔔 /تنبيه SYMBOL فوق/تحت PRICE\n📋 /مستويات SYMBOL\n\n💡 مباشر أولاً ← ياهو fallback`, {parse_mode:'Markdown'}));

bot.onText(/\/فحص\s+(\w+)/i, async (msg, m) => {
  const load = await bot.sendMessage(msg.chat.id, `🔍 جاري فحص ${m[1].toUpperCase()}...`);
  const r = await analyze(m[1]);
  if(!r.ok) return bot.editMessageText(r.msg, {chat_id:msg.chat.id, message_id:load.message_id});
  if(r.partial) return bot.editMessageText(r.msg, {chat_id:msg.chat.id, message_id:load.message_id, parse_mode:'Markdown'});
  const d = r.data;
  let txt = `${d.passed?'🎉':'📊'} *${d.sym}* | ${d.price} جنيه [${d.tag}]\n`;
  txt += `حجم: ${d.vol.toLocaleString()} ${d.checks.vol.thr?'(مطلوب:'+d.checks.vol.thr.toLocaleString()+')':''}\n`;
  txt += `استقرار: ${d.checks.stab.chg?.toFixed(2)}% (<2%)\n`;
  txt += `اتجاه: فوق EMA50(${d.checks.trend.e50?.toFixed(1)}) & EMA200(${d.checks.trend.e200?.toFixed(1)})\n`;
  txt += `RSI: ${d.checks.rsi.val?.toFixed(1)} (48-55)\n`;
  txt += `MACD: ${d.checks.macd.val?.toFixed(3)} (≈0)\n\n`;
  txt += `النتيجة: ${d.score}/${d.total}`;
  if(d.passed) txt += `\n🚀 *ممتاز!*`;
  bot.editMessageText(txt, {chat_id:msg.chat.id, message_id:load.message_id, parse_mode:'Markdown'});
});

bot.onText(/\/اضافة\s+(\w+)/i, (msg, m) => {
  const s=m[1].toUpperCase(), c=msg.chat.id;
  if(!watchlist.has(c)) watchlist.set(c,[]);
  const l=watchlist.get(c);
  l.includes(s) ? bot.sendMessage(msg.chat.id, `⚠️ ${s} موجود`) : (l.push(s), bot.sendMessage(msg.chat.id, `✅ أضيف ${s}`));
});

bot.onText(/\/قائمة/, msg => {
  const l=watchlist.get(msg.chat.id);
  bot.sendMessage(msg.chat.id, !l?.length?'📭 فارغة':'📋 *قائمة:*\n'+l.map((s,i)=>`${i+1}. *${s}*`).join('\n'), {parse_mode:'Markdown'});
});

bot.onText(/\/حذف\s+(\w+)/i, (msg, m) => {
  const s=m[1].toUpperCase(), l=watchlist.get(msg.chat.id);
  !l?.includes(s) ? bot.sendMessage(msg.chat.id, `⚠️ ${s} مش موجود`) : (l.splice(l.indexOf(s),1), bot.sendMessage(msg.chat.id, `✅ اتحذف ${s}`));
});

bot.onText(/\/(دعم|مقاومة)\s+(\w+)\s+([\d.]+)/i, (msg, m) => {
  const type=m[1], sym=m[2].toUpperCase(), price=parseFloat(m[3]);
  if(!srLevels.has(msg.chat.id)) srLevels.set(msg.chat.id, {});
  if(!srLevels.get(msg.chat.id)[sym]) srLevels.get(msg.chat.id)[sym]={support:[],resistance:[]};
  srLevels.get(msg.chat.id)[sym][type==='دعم'?'support':'resistance'].push(price);
  bot.sendMessage(msg.chat.id, `✅ تم: ${type} ${sym} عند ${price}`);
});

bot.onText(/\/مستويات\s+(\w+)/i, (msg, m) => {
  const sr = srLevels.get(msg.chat.id)?.[m[1].toUpperCase()] || {support:[],resistance:[]};
  bot.sendMessage(msg.chat.id, `📐 مستويات ${m[1].toUpperCase()}:\n🟢 دعم: ${sr.support.join(', ')||'لا يوجد'}\n🔴 مقاومة: ${sr.resistance.join(', ')||'لا يوجد'}`);
});

bot.onText(/\/فحص_الكل/, async msg => {
  const l=watchlist.get(msg.chat.id);
  if(!l?.length) return bot.sendMessage(msg.chat.id, '📭 القائمة فارغة');
  const load = await bot.sendMessage(msg.chat.id, `🔍 بفحص ${l.length} سهم...`);
  let res=[];
  for(const s of l){ const r=await analyze(s); if(r.ok&&r.data) res.push(r.data); }
  res.sort((a,b)=>b.score-a.score);
  bot.editMessageText('📊 *النتائج:*\n'+res.map(d=>`${d.passed?'🎉':d.score>=4?'✅':'⚠️'} *${d.sym}*: ${d.score}/${d.total} | ${d.price} [${d.tag}]`).join('\n'), {chat_id:msg.chat.id, message_id:load.message_id, parse_mode:'Markdown'});
});

bot.onText(/\/مسح_السوق/, async msg => {
  const load = await bot.sendMessage(msg.chat.id, `🌍 مسح ${EGX_LIST.length} سهم...`);
  let buys=[], breaks=[];
  for(const sym of EGX_LIST){
    const r=await analyze(sym);
    if(r.ok && !r.partial && r.data.passed) buys.push(r.data);
    if(r.ok && !r.partial && r.data.checks.rsi.val>60 && r.data.checks.vol.pass) breaks.push(r.data);
  }
  let txt = `🌍 *تقرير السوق*\n\n🎯 فرص شراء (${buys.length}):\n${buys.map(d=>`• *${d.sym}* ${d.price} [${d.tag}]`).join('\n')||'لا يوجد'}\n\n🚀 اختراقات (${breaks.length}):\n${breaks.map(d=>`• *${d.sym}* ${d.price} RSI:${d.checks.rsi.val?.toFixed(0)}`).join('\n')||'لا يوجد'}`;
  bot.editMessageText(txt, {chat_id:msg.chat.id, message_id:load.message_id, parse_mode:'Markdown'});
});

bot.onText(/\/فرص_الشراء/, async msg => {
  const load = await bot.sendMessage(msg.chat.id, ' أبحث عن فرص...');
  let found=[];
  for(const sym of EGX_LIST){ const r=await analyze(sym); if(r.ok&&!r.partial&&r.data.passed) found.push(r.data); }
  bot.editMessageText(found.length?`🎯 *فرص شراء:*\n`+found.map(d=>`• *${d.sym}* ${d.price} [${d.tag}]`).join('\n'):'😴 مفيش فرص دلوقتي', {chat_id:msg.chat.id, message_id:load.message_id, parse_mode:'Markdown'});
});

bot.onText(/\/اختراقات/, async msg => {
  const load = await bot.sendMessage(msg.chat.id, '🚀 أبحث عن اختراقات...');
  let found=[];
  for(const sym of EGX_LIST){ const r=await analyze(sym); if(r.ok&&!r.partial&&r.data.checks.rsi.val>60&&r.data.checks.vol.pass) found.push(r.data); }
  bot.editMessageText(found.length?`🚀 *اختراقات:*\n`+found.map(d=>`• *${d.sym}* ${d.price} RSI:${d.checks.rsi.val?.toFixed(1)}`).join('\n'):'📉 مفيش اختراقات', {chat_id:msg.chat.id, message_id:load.message_id, parse_mode:'Markdown'});
});

bot.onText(/\/تنبيه\s+(\w+)\s+(فوق|تحت)\s+([\d.]+)/i, (msg, m) => {
  const c=msg.chat.id; if(!priceAlerts.has(c)) priceAlerts.set(c,[]);
  priceAlerts.get(c).push({sym:m[1].toUpperCase(), type:m[2], price:parseFloat(m[3])});
  bot.sendMessage(msg.chat.id, `✅ تم: ${m[1].toUpperCase()} ${m[2]} ${m[3]}`);
});

setInterval(async () => {
  console.log('🔄 فحص دوري...');
  for(const [c, list] of watchlist){
    for(const s of list){
      const r=await analyze(s);
      if(r.ok&&r.data&&r.data.passed) bot.sendMessage(c, `🚨 *${r.data.sym} حقق الفلتر!*\n💰 ${r.data.price} [${r.data.tag}]`, {parse_mode:'Markdown'});
    }
  }
  for(const [c, symbols] of srLevels){
    for(const [sym, levels] of Object.entries(symbols)){
      const curr=await getCurrentPrice(sym);
      if(!curr) continue;
      for(const sp of levels.support) if(Math.abs(curr.price-sp)<0.1) bot.sendMessage(c, `🟢 ${sym} لمس الدعم ${sp}`, {parse_mode:'Markdown'});
      for(const rp of levels.resistance) if(Math.abs(curr.price-rp)<0.1) bot.sendMessage(c, `🔴 ${sym} لمس المقاومة ${rp}`, {parse_mode:'Markdown'});
    }
  }
  for(const [c, alerts] of priceAlerts){
    for(let i=alerts.length-1;i>=0;i--){
      const a=alerts[i], curr=await getCurrentPrice(a.sym);
      if(!curr) continue;
      if((a.type==='فوق'&&curr.price>=a.price)||(a.type==='تحت'&&curr.price<=a.price)){
        bot.sendMessage(c, `🔔 ${a.sym} ${a.type} ${a.price}: ${curr.price}`);
        alerts.splice(i,1);
      }
    }
  }
}, 3600000);

console.log('✅ Bot Running v3.0');