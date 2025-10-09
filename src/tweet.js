// tweet.js
import { TwitterApi } from 'twitter-api-v2';

// ---------- Config ----------
const {
    X_API_KEY,
    X_API_SECRET,
    X_ACCESS_TOKEN,
    X_ACCESS_SECRET,
    X_MIN_INTERVAL_MS = '2000',   // default ~0.5 tweet/sec
    X_MAX_QUEUE       = '500',    // cap queue size
    X_DRY_RUN         = '0',      // if "1", log instead of tweeting
} = process.env;

const MIN_INTERVAL_MS = Number(X_MIN_INTERVAL_MS) || 2000;
const MAX_QUEUE       = Number(X_MAX_QUEUE) || 500;
const DRY_RUN         = X_DRY_RUN === '1';

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

const queue = [];
const PERIODIC_LOG_EVERY_MS = 60_000;
let lastPeriodicLog = 0;

export async function tweetLiquidation({ text, notional = 0 }) {
    if (!text || typeof text !== 'string') return;

    const score = Number.isFinite(+notional) ? +notional : 0;
    const job = { text, notional: score, ts: Date.now() };

    enqueueByPriority(job);
    logQueue('enqueue', { added: true, notional: score });

    if (!sending) {
        sending = true;
        drain();
    }
}


function enqueueByPriority(job) {
    // keep queue sorted DESC by notional
    if (queue.length >= MAX_QUEUE) {
        const tail = queue[queue.length - 1];
        if (tail && job.notional <= tail.notional) {

            logQueue('drop_small', { notional: job.notional });
            return;
        }
        queue.pop();
    }


    let lo = 0, hi = queue.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (job.notional >= queue[mid].notional) hi = mid; else lo = mid + 1;
    }
    queue.splice(lo, 0, job);
}

function logQueue(tag, extra = {}) {
    const paused = pausedUntil && Date.now() < pausedUntil;
    const base = `[x][${tag}] queue=${queue.length} paused=${paused}`;
    const pauseStr = paused ? ` until=${new Date(pausedUntil).toISOString()}` : '';
    const extraStr = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
    console.log(base + pauseStr + extraStr);
}

function nextWakeDelay() {
    // ensure minimum spacing between sends
    const since = Date.now() - lastSentAt;
    return Math.max(0, MIN_INTERVAL_MS - since);
}

async function drain() {
    const now = Date.now();

    // periodic heartbeat
    if (now - lastPeriodicLog >= PERIODIC_LOG_EVERY_MS) {
        logQueue('tick', { sentCount, lastSentAt: lastSentAt ? new Date(lastSentAt).toISOString() : null });
        lastPeriodicLog = now;
    }

    // respect pause if rate-limited earlier
    if (now < pausedUntil) {
        const ms = pausedUntil - now;
        logQueue('paused_wait', { ms });
        setTimeout(drain, ms + 50);
        return;
    }

    const job = queue.shift();
    if (!job) {
        sending = false;
        logQueue('idle');
        return;
    }

    // throttle between sends
    const wait = nextWakeDelay();
    if (wait > 0) {
        logQueue('spacing_wait', { wait, next: new Date(Date.now() + wait).toISOString() });
        setTimeout(() => doSend(job), wait);
    } else {
        await doSend(job);
    }
    setTimeout(drain, 10); // keep the loop reactive
}

async function doSend(job) {
    logQueue('dequeue', { notional: job.notional, textPreview: job.text.slice(0, 100) });

    if (DRY_RUN) {
        console.log('[x] DRY_RUN on — not sending:', job.text);
        lastSentAt = Date.now();
        sentCount += 1;
        return;
    }

    try {
        const res = await safeTweet({ text: job.text });
        if (res?.data?.id) {
            console.log(`[x] sent ok id=${res.data.id}`);
        }
        lastSentAt = Date.now();
        sentCount += 1;
    } catch (e) {
        console.error('[x] tweet fatal error:', explainError(e));
        // we *don’t* requeue on unknown fatal errors; adjust if you want
    }
}

async function safeTweet(payload) {
    try {
        const res = await client.v2.tweet(payload);
        const rl = res?.rateLimit;
        if (rl) {
            console.log(`[x] success rate: limit=${rl.limit} remaining=${rl.remaining} reset=${iso(rl.reset * 1000)}`);
        } else {
            console.log('[x] success (no rate headers)');
        }
        return res;
    } catch (e) {
        const rl = e?.rateLimit;
        if (isRateLimitError(e)) {
            const resetMs = rl?.reset ? rl.reset * 1000 : (Date.now() + 60_000);
            pausedUntil = resetMs;
            console.warn(`[x] 429 Too Many Requests. Pausing until ${iso(resetMs)} (queue=${queue.length})`
                + (rl ? ` [limit=${rl.limit} rem=${rl.remaining}]` : ''));
            throw e;
        }

        console.error('[x] non-429 error:', explainError(e));
        if (rl) {
            console.error(`[x] err rate: limit=${rl.limit} remaining=${rl.remaining} reset=${iso(rl.reset * 1000)}`);
        }
        throw e;
    }
}

function isRateLimitError(err) {
    return err?.code === 429
        || err?.data?.title === 'Too Many Requests'
        || !!err?.rateLimitError;
}

function iso(ms) {
    return new Date(ms).toISOString();
}

function explainError(e) {
    const parts = [];
    if (!e) return 'unknown';
    parts.push(e.message || String(e));
    if (e.code) parts.push(`code=${e.code}`);
    if (e.data?.title) parts.push(`title=${e.data.title}`);
    if (e.data?.detail) parts.push(`detail=${e.data.detail}`);
    if (e?.rateLimit?.reset) parts.push(`reset=${iso(e.rateLimit.reset * 1000)}`);
    return parts.join(' ');
}

console.log(`[x] init MIN_INTERVAL_MS=${MIN_INTERVAL_MS} MAX_QUEUE=${MAX_QUEUE} DRY_RUN=${DRY_RUN}`);
