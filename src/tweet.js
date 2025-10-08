import { TwitterApi } from 'twitter-api-v2';

const {
    X_API_KEY,
    X_API_SECRET,
    X_ACCESS_TOKEN,
    X_ACCESS_SECRET,
} = process.env;

if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    console.error('[x] Missing X (Twitter) credentials in env');
}

const client = new TwitterApi({
    appKey: X_API_KEY,
    appSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_SECRET,
});

const queue = [];
let sending = false;
let pausedUntil = 0;

const MIN_INTERVAL_MS = 1200;
const MAX_QUEUE       = 500;
const LOG_EVERY_MS    = 60_000;

let lastPeriodicLog = 0;

export async function tweetLiquidation({ text, notional = 0 }) {
    if (!text || typeof text !== 'string') return;
    const score = Number.isFinite(notional) ? Number(notional) : 0;

    const job = { text, notional: score, ts: Date.now() };
    enqueueByPriority(job);
    logQueue('enqueue');

    if (!sending) {
        sending = true;
        drain();
    }
}

function enqueueByPriority(job) {
    if (queue.length >= MAX_QUEUE) {
        const smallest = queue[queue.length - 1];
        if (smallest && job.notional <= smallest.notional) {
            return;
        }
        queue.pop();
    }

    if (queue.length === 0 || job.notional >= queue[0].notional) {
        queue.unshift(job);
        return;
    }
    if (job.notional <= queue[queue.length - 1].notional) {
        queue.push(job);
        return;
    }

    const idx = queue.findIndex(j => job.notional > j.notional);
    if (idx === -1) queue.push(job);
    else queue.splice(idx, 1, job, queue[idx]); // simple swap-in
}

// Safer: real insert preserving order
// (use this instead of the splice trick above if you prefer clarity)
/*
function enqueueByPriority(job) {
  if (queue.length >= MAX_QUEUE) {
    const smallest = queue[queue.length - 1];
    if (smallest && job.notional <= smallest.notional) return;
    queue.pop();
  }
  let i = 0;
  while (i < queue.length && queue[i].notional >= job.notional) i++;
  queue.splice(i, 0, job);
}
*/

async function drain() {
    const now = Date.now();

    // Periodic queue length log
    if (now - lastPeriodicLog >= LOG_EVERY_MS) {
        logQueue('tick');
        lastPeriodicLog = now;
    }

    if (now < pausedUntil) {
        const ms = pausedUntil - now;
        setTimeout(drain, ms);
        return;
    }

    const job = queue.shift();
    if (!job) {
        sending = false;
        return;
    }

    try {
        await safeTweet({ text: job.text });
    } catch (e) {
        console.error('[x] tweet error:', briefError(e));
    }

    setTimeout(drain, MIN_INTERVAL_MS);
}

async function safeTweet(payload) {
    try {
        return await client.v2.tweet(payload);
    } catch (e) {
        if (isRateLimitError(e)) {
            const resetMs = rateLimitResetMs(e);
            if (resetMs) {
                pausedUntil = resetMs;
                console.warn(`[x] 429 rate limited. Pausing until ${new Date(resetMs).toISOString()} (queue=${queue.length})`);
            } else {
                const fallback = 60_000;
                pausedUntil = Date.now() + fallback;
                console.warn(`[x] 429 rate limited. Pausing ${fallback}ms (queue=${queue.length})`);
            }
            return;
        }
        throw e;
    }
}

function isRateLimitError(err) {
    return err?.code === 429 || err?.data?.title === 'Too Many Requests' || !!err?.rateLimitError;
}

function rateLimitResetMs(err) {
    const resetSec = err?.rateLimit?.reset ?? err?.data?.reset ?? null;
    return resetSec ? Number(resetSec) * 1000 : null;
}

function briefError(e) {
    if (!e) return 'unknown';
    const msg = e.message || e.toString();
    const code = e.code ? ` code=${e.code}` : '';
    return `${msg}${code}`;
}

function logQueue(tag) {
    if (pausedUntil && Date.now() < pausedUntil) {
        console.log(`[x][${tag}] queue=${queue.length}, pausedUntil=${new Date(pausedUntil).toISOString()}`);
    } else {
        console.log(`[x][${tag}] queue=${queue.length}, paused=false`);
    }
}
