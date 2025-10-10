import { TwitterApi } from 'twitter-api-v2';
import  { PriorityQueue } from './priority-queue.js';

// ---------- Config ----------
const {
    X_API_KEY,
    X_API_SECRET,
    X_ACCESS_TOKEN,
    X_ACCESS_SECRET,
    X_MIN_INTERVAL_MS = '4000',   // default ~0.5 tweet/sec
    X_MAX_QUEUE       = '500',    // cap queue size
} = process.env;

const MIN_INTERVAL_MS = Number(X_MIN_INTERVAL_MS) || 4000;
const MAX_QUEUE       = Number(X_MAX_QUEUE) || 500;

// ---------- Client ----------
if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    console.error('[x] Missing credentials in env (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET)');
}

const client = new TwitterApi({
    appKey: X_API_KEY,
    appSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_SECRET,
});

// ---------- State ----------
let pausedUntil = 0;
let sending = false;
let lastSentAt = 0;
let sentCount = 0;
const queue = new PriorityQueue({
    capacity: 500,
    getPriority: (job) => Number(job.notional || 0),
    tieBreaker: (a, b) => b.ts - a.ts,
});

function log(tag, extra={}) {
    const paused = pausedUntil && Date.now() < pausedUntil;
    const base = { queue: queue.size(), paused: paused ? pausedUntil : 0, sentCount, lastSentAt };
    console.log(`[x][${tag}]`, JSON.stringify({ ...base, ...extra }));
}

export async function tweetLiquidation({ text, notional = 0 }) {
    if (!client || !text) return;
    const res = queue.enqueue({ text, notional, ts: Date.now() });
    log('enqueue', { added: res.added, notional });

    if (!sending) { sending = true; drain(); }
}

async function drain() {
    const now = Date.now();
    if (pausedUntil && now < pausedUntil) {
        const ms = pausedUntil - now;
        log('paused_wait', { ms });
        setTimeout(drain, ms);
        return;
    }

    const job = queue.dequeue();
    if (!job) { sending = false; return; }
    log('dequeue', { notional: job.notional, textPreview: job.text.slice(0,80) });

    try {
        await safeTweet({ text: job.text });
        sentCount += 1;
        lastSentAt = Date.now();
    } catch (e) {
        console.error('[x] tweet fatal error:', e.message || e);
    }

    setTimeout(drain, MIN_INTERVAL_MS);
}

async function safeTweet(payload) {
    try {
        return await client.v2.tweet(payload);
    } catch (e) {
        const resetMs = getResetMs(e);
        if (resetMs) {
            pausedUntil = resetMs;
            console.warn(`[x] 429 Too Many Requests. Pausing until ${new Date(resetMs).toISOString()} (queue=${queue.size()}) [limit=${e?.rateLimit?.limit} rem=${e?.rateLimit?.remaining}]`);
            return;
        }
        pausedUntil = Date.now() + 60_000;
        console.warn(`[x] error; backoff 60s. ${e?.message || e}`);
    }
}

function getResetMs(err) {
    const resetSec = err?.rateLimit?.reset ? Number(err.rateLimit.reset) : null;
    if (resetSec) return resetSec * 1000;
    const detailReset = err?.data?.reset;
    if (detailReset) {
        const t = new Date(detailReset).getTime();
        if (Number.isFinite(t)) return t;
    }
    return null;
}
