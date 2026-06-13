const TelegramBot = require('node-telegram-bot-api');
const yahooFinance = require('yahoo-finance2').default;
const { RSI, EMA } = require('technicalindicators');

// 1. توكن البوت (تم وضعه كما طلبت، لكن يُفضل تغييره من BotFather للأمان)
const token = '8372311269:AAHYGU-Bu1VnteJwpTUXkNwSMmcDNoUEfcg';
const bot = new TelegramBot(token, { polling: true });

// 2. قائمة الأسهم (يمكنك إضافة أو حذف أسهم من هنا)
const WATCHLIST = ['COMI', 'FWRY', 'HRHO', 'ESRS', 'AMOC', 'ORWE', 'ABUK', 'PHDC', 'ETEL', 'SWDY'];

// 3. دالة التحليل الفني المتقدم
async function analyzeStock(symbol) {
    try {
        // جلب بيانات آخر 65 يوم لضمان حساب EMA 50 و RSI بدقة
        const history = await yahooFinance.chart(`${symbol}.CA`, {
            period1: new Date(Date.now() - 65 * 24 * 60 * 60 * 1000),
            interval: '1d'
        });

        if (!history.quotes || history.quotes.length < 50) return null;

        const quotes = history.quotes;
        const closes = quotes.map(q => q.close).filter(v => v != null);
        const highs = quotes.map(q => q.high).filter(v => v != null);
        const lows = quotes.map(q => q.low).filter(v => v != null);
        const volumes = quotes.map(q => q.volume).filter(v => v != null);

        const currentPrice = closes[closes.length - 1];
        const currentVolume = volumes[volumes.length - 1];
        const prevPrice = closes[closes.length - 2];

        // حساب المؤشرات الفنية
        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema50 = EMA.calculate({ period: 50, values: closes });
        
        const currentRsi = rsi[rsi.length - 1];
        const currentEma50 = ema50[ema50.length - 1];

        // حساب الدعم والمقاومة (أعلى وأقل سعر في آخر 20 يوم)
        const recentHighs = highs.slice(-20);
        const recentLows = lows.slice(-20);
        const resistance = Math.max(...recentHighs);
        const support = Math.min(...recentLows);

        // حساب متوسط حجم التداول لآخر 10 أيام
        const recentVolumes = volumes.slice(-11, -1);
        const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;

        let signal = null;
        let reason = "";

        // ================= الفلاتر المتقدمة =================

        // فلتر 1: اختراق مقاومة حقيقي (Breakout)
        // الشروط: السعر كسر المقاومة + حجم التداول أعلى من المتوسط بـ 20% + السعر فوق متوسط 50 يوم
        if (currentPrice >= resistance * 0.99) {
            if (currentVolume > avgVolume * 1.2 && currentPrice > currentEma50) {
                signal = "🚀 اختراق مقاومة قوي (Breakout)";
                reason = `كسر قمة 20 يوم (${resistance.toFixed(2)}) بحجم تداول عالي (${(currentVolume/1000000).toFixed(1)}M) والسعر فوق EMA 50.`;
            }
        } 
        
        // فلتر 2: ارتداد من دعم قوي (Support Bounce)
        // الشروط: السعر قريب من الدعم (أقل من 3%) + تشبع بيعي (RSI < 35) + السعر لا يزال فوق متوسط 50 يوم (لتجنب السقوط الحر)
        else {
            const distanceToSupport = ((currentPrice - support) / support) * 100;
            if (distanceToSupport <= 3 && currentRsi < 35 && currentPrice > currentEma50) {
                signal = "🛡️ ارتداد من دعم قوي (Support Bounce)";
                reason = `السعر عند الدعم (${support.toFixed(2)}) مع تشبع بيعي (RSI: ${currentRsi.toFixed(1)}) والاتجاه العام صعودي.`;
            }
        }

        // إذا لم يحقق الشروط الصارمة، نتجاهله
        if (!signal) return null;

        return {
            symbol,
            price: currentPrice.toFixed(2),
            support: support.toFixed(2),
            resistance: resistance.toFixed(2),
            rsi: currentRsi.toFixed(1),
            ema50: currentEma50.toFixed(2),
            volume: (currentVolume / 1000000).toFixed(1) + 'M',
            signal,
            reason
        };

    } catch (error) {
        return null; // تجاهل الأخطاء الفردية للاستمرار في فحص باقي الأسهم
    }
}

// 4. أمر التليجرام للفحص
bot.onText(/\/scan/, async (msg) => {
    const chatId = msg.chat.id;
    
    bot.sendMessage(chatId, "⏳ جاري فحص السوق بالفلاتر المتقدمة (Volume + RSI + EMA 50)... قد يستغرق ذلك 10-15 ثانية.");

    const results = await Promise.all(WATCHLIST.map(symbol => analyzeStock(symbol)));
    const buySignals = results.filter(r => r !== null);

    if (buySignals.length === 0) {
        bot.sendMessage(chatId, "⚠️ لا توجد إشارات شراء تطابق الفلاتر الصارمة حالياً. السوق يحتاج لمزيد من الانتظار.");
        return;
    }

    let message = "🚨 *إشارات الشراء المؤكدة اليوم:* 🚨\n\n";
    buySignals.forEach(stock => {
        message += `💎 *${stock.symbol}*\n`;
        message += `السعر: ${stock.price} | الحجم: ${stock.volume}\n`;
        message += `الدعم: ${stock.support} | المقاومة: ${stock.resistance}\n`;
        message += `RSI: ${stock.rsi} | EMA 50: ${stock.ema50}\n`;
        message += `📌 الإشارة: *${stock.signal}*\n`;
        message += `📝 السبب: ${stock.reason}\n`;
        message += `-------------------------\n`;
    });

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// رسالة تأكيد التشغيل
console.log("✅ البوت يعمل الآن بنجاح وجاهز لاستقبال الأوامر... 🚀");