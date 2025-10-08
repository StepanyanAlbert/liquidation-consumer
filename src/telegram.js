// src/telegram.js
const queue = [];
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

let sending = false;

function fmtNotional(v) {
    if (v >= 1e9) return (v/1e9).toFixed(2)+'B';
    if (v >= 1e6) return (v/1e6).toFixed(2)+'M';
    if (v >= 1e3) return (v/1e3).toFixed(1)+'K';
    return v.toFixed(2);
}

// telegram.js (or wherever your queue lives)
let pausedUntil = 0;
const SEND_INTERVAL_MS = 1200; // ~0.8 msg/sec steady

async function sendTelegram(text) {
    queue.push(text);
    if (sending) return;
    sending = true;

    (async function drain() {
        const now = Date.now();
        if (now < pausedUntil) {
            return setTimeout(drain, pausedUntil - now);
        }

        const item = queue.shift();
        if (!item) { sending = false; return; }

        try {
            const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type':'application/json' },
                body: JSON.stringify({ chat_id: CHAT_ID, text: item, disable_web_page_preview: true })
            });

            if (!r.ok) {
                const bodyText = await r.text().catch(()=> '');
                let retryAfter = 0;
                try {
                    const body = JSON.parse(bodyText);
                    retryAfter = body?.parameters?.retry_after ? Number(body.parameters.retry_after) * 1000 : 0;
                } catch {}

                if (r.status === 429 && retryAfter > 0) {
                    console.error('[tg] 429. Pausing for', retryAfter, 'ms');
                    queue.unshift(item);
                    pausedUntil = Date.now() + retryAfter;
                } else {
                    console.error('[tg] send error', r.status, bodyText.slice(0,300));
                }
            }
        } catch (e) {
            console.error('[tg] fetch error:', e.message);
        }

        setTimeout(drain, SEND_INTERVAL_MS);
    })();
}

module.exports = { sendTelegram, fmtNotional };
