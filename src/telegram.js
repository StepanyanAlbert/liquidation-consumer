import https from 'https';
import { fetch, Agent, setGlobalDispatcher } from 'undici';
import  { PriorityQueue } from './priority-queue.js';

const dispatcher = new Agent({ connections: 50, keepAliveTimeout: 60_000 });
setGlobalDispatcher(dispatcher);

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const SEND_INTERVAL_MS = 1200;
let pausedUntil = 0;
let sending = false;

const queue = new PriorityQueue({
    capacity: 500,
    getPriority: (job) => Number(job.notional || 0),
    tieBreaker: (a, b) => b.ts - a.ts,
});

function log(tag) {
    const paused = pausedUntil && Date.now() < pausedUntil;
    console.log(`[tg][${tag}] q=${queue.size()} paused=${paused ? new Date(pausedUntil).toISOString() : 0}`);
}

export async function sendTelegram({ text, notional = 0 }) {
    if (!BOT_TOKEN || !CHAT_ID) return;

    const res = queue.enqueue({ text, notional, ts: Date.now() });
    log('enqueue');

    if (!sending) {
        sending = true;
        drain();
    }
}

async function drain() {
    const now = Date.now();
    if (pausedUntil && now < pausedUntil) {
        setTimeout(drain, pausedUntil - now);
        return;
    }

    const job = queue.dequeue();
    if (!job) { sending = false; return; }

    try {
        const agent = new https.Agent({ keepAlive: true, maxSockets: 50 });
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify({ chat_id: CHAT_ID, text: job.text, disable_web_page_preview: true }),
        });

        if (!r.ok) {
            const txt = await r.text().catch(()=> '');
            let retryAfter = 0;
            try {
                const body = JSON.parse(txt);
                retryAfter = body?.parameters?.retry_after ? Number(body.parameters.retry_after) * 1000 : 0;
            } catch {}
            if (r.status === 429 && retryAfter > 0) {
                pausedUntil = Date.now() + retryAfter;
                queue.enqueue(job);
                log(`429_pause_${retryAfter}ms`);
            } else {
                console.error('[tg] send error', r.status, txt.slice(0, 300));
            }
        }
    } catch (e) {
        console.error('[tg] fetch error:', e.message);
    }

    setTimeout(drain, SEND_INTERVAL_MS);
}
