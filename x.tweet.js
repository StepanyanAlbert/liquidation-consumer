import { chromium } from 'playwright';
import {PriorityQueue} from "./src/priority-queue.js";

const STATE_FILE = process.env.X_STORAGE_STATE;
const MIN_INTERVAL_MS = Number(process.env.X_MIN_INTERVAL_MS || 4000);
const IDLE_CLOSE_MS   = 30000;

let browser = null;
let context = null;
let page = null;
let sending = false;
let lastPostAt = 0;
let idleTimer = null;

const queue = new PriorityQueue({
    capacity: 500,
    getPriority: (job) => Number(job.notional || 0),
    tieBreaker: (a, b) => b.ts - a.ts,
});

// --- lifecycle helpers ---
async function ensureBrowser() {
    if (browser && context && page) return;

    browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
    });

    context = await browser.newContext({ storageState: STATE_FILE });
    page = await context.newPage();
}

async function teardownBrowser() {
    clearIdleTimer();
    try {
        await page?.close().catch(() => {});
        await context?.close().catch(() => {});
        await browser?.close().catch(() => {});
    } finally {
        browser = context = page = null;
    }
}

function armIdleTimer() {
    clearIdleTimer();
    idleTimer = setTimeout(async () => {
        if (!sending && queue.isEmpty()) {
            console.log('[xposter] idle timeout → closing browser');
            await teardownBrowser();
        }
    }, IDLE_CLOSE_MS).unref?.();
}

function clearIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

export function enqueueTweet({ text, notional = 0 }) {
    const res = queue.enqueue({ text, notional, ts: Date.now() });
    console.log(`[xposter][enqueue] q=${queue.size()} added=${res.added}`);

    if (!sending) {
        sending = true;
        drain().catch(e => console.error('[xposter] drain error:', e?.message || e));
    }
}

export async function stopXPoster() {
    queue.clear();
    sending = false;
    await teardownBrowser();
}

async function drain() {
    await ensureBrowser();

    while (!queue.isEmpty()) {
        const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastPostAt));
        if (wait > 0) await new Promise(r => setTimeout(r, wait));

        const job = queue.dequeue();
        if (!job) break;

        try {
            await postOnce(job.text);
            lastPostAt = Date.now();
            console.log(`[xposter] posted (${job.notional.toFixed(0)} USD)`);
        } catch (e) {
            console.error('[xposter] post failed:', e?.message || e);
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    sending = false;
    armIdleTimer();
}

// --- single tweet execution ---
async function postOnce(text) {
    await page.goto('https://x.com/compose/tweet', { waitUntil: 'domcontentloaded' });

    const textBox = page.locator('[data-testid="tweetTextarea_0"].public-DraftEditor-content[contenteditable="true"]').first();
    await textBox.waitFor({ timeout: 15000 });

    await textBox.click();
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(text, { delay: 5 });

    const postBtn = page.getByRole('button', { name: /Post|Tweet/i });
    await postBtn.waitFor({ timeout: 10000 });
    await postBtn.click();
    await page.waitForTimeout(1500);
}
