
const WebSocket = require('ws');

const MIN_NOTIONAL_USD = 10_00;
const BOT_TOKEN= process.env.BOT_TOKEN
const CHAT_ID= process.env.CHAT_ID
if (!BOT_TOKEN || !CHAT_ID) {
    console.error('Missing BOT_TOKEN or CHAT_ID env vars');
    process.exit(1);
}

const SEND_INTERVAL_MS = 250;
const queue = [];
let sending = false;

async function tgFetch(method, payload) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok || (json && json.ok === false)) {
        const desc = json?.description || text;
        throw new Error(`Telegram API error (${method}): ${desc}`);
    }
    return json ?? text;
}

async function sendTelegram(text) {
    queue.push(text);
    if (sending) return;
    sending = true;
    (async function drain() {
        const item = queue.shift();
        if (!item) { sending = false; return; }
        try {
            await tgFetch('sendMessage', { chat_id: CHAT_ID, text: item, disable_web_page_preview: true });
        } catch (e) {
            console.error('[TG] send error:', e.message);
        }
        setTimeout(drain, SEND_INTERVAL_MS);
    })();
}

function fmtNotional(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(2);
}

function formatLine(evt) {
    const emoji = evt.side === 'Long' ?  '🔴' : '🟢';
    const exTag = EXCHANGE_TAGS[evt.exchange] || evt.exchange;
    const symbolHash = evt.symbol.startsWith('#') ? evt.symbol : `#${evt.symbol}`;
    return `${emoji} ${exTag} ${symbolHash} Liquidated ${evt.side}: $${fmtNotional(evt.notional)} at $${evt.price.toFixed(2)}`;
}


const EXCHANGE_TAGS = {
    binance: ' Binance',
    bybit: ' Bybit',
    // okx: '⚫ OKX',
};

function createBybitAdapter({ symbols = [] } = {}) {
    const name = 'bybit';
    const url  = 'wss://stream.bybit.com/v5/public/linear';

    if (!Array.isArray(symbols) || symbols.length === 0) {
        console.warn(`[${name}] No symbols provided. Bybit requires per-symbol subscriptions like allLiquidation.BTCUSDT`);
    }

    const args = symbols.map(s => `allLiquidation.${String(s).toUpperCase()}`);

    let attempt = 0;
    let pingTimer = null;
    let ws = null;

    function subscribe() {
        if (args.length === 0) return;
        const sub = { op: 'subscribe', args };
        console.log(`[${name}] sending subscribe:`, JSON.stringify(sub));
        ws.send(JSON.stringify(sub));
    }

    function handleServerMessage(raw, onEvent) {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) {
            console.error(`[${name}] JSON parse error:`, e.message, 'raw=', String(raw).slice(0, 300));
            return;
        }


        if (msg.op === 'ping') {
            const pong = { op: 'pong' };
            if (msg.ts) pong.ts = msg.ts;
            try { ws.send(JSON.stringify(pong)); } catch (e) {
                console.error(`[${name}] failed to send pong:`, e.message);
            }
            return;
        }

        if (Object.prototype.hasOwnProperty.call(msg, 'success')) {
            console.log(`[${name}] subscribe ack: success=${msg.success} retMsg=${msg.retMsg || ''} code=${msg.code || ''}`);
            if (msg.success === false) {
                console.error(`[${name}] subscription failed:`, JSON.stringify(msg));
            }
            return;
        }

        // Data messages: topic like "allLiquidation.BTCUSDT"
        const topic = typeof msg.topic === 'string' ? msg.topic : '';
        if (!/^allLiquidation\./.test(topic)) return;
        if (!Array.isArray(msg.data)) return;

        for (const row of msg.data) {
            const rawSym = String(row.s || '');
            const symbol = rawSym.replace(/(USDT|USDC)$/i, '');

            const sideStr = row.S;
            const side = sideStr === 'Buy' ? 'Long' : 'Short';

            const qty   = parseFloat(row.v ?? '0');
            const price = parseFloat(row.p ?? '0');
            if (!qty || !price) continue;

            const notional = qty * price;
            if (notional < MIN_NOTIONAL_USD) continue;

            const ts = row.T || msg.ts || Date.now();

            onEvent({
                exchange: name,
                ts,
                symbol,
                side,
                price,
                qty,
                notional,
                raw: msg
            });
        }
    }

    function connect(onEvent) {
        ws = new WebSocket(url);

        ws.on('open', () => {
            attempt = 0;
            console.log(`[${name}] connected`);
            subscribe();
            // TCP ping (transport keepalive). JSON ping/pong handled above.
            pingTimer = setInterval(() => {
                try { ws.ping(); } catch (e) { console.error(`[${name}] ping error:`, e.message); }
            }, 60_000);
        });

        ws.on('message', (raw) => handleServerMessage(raw, onEvent));

        ws.on('close', (code, reasonBuf) => {
            if (pingTimer) clearInterval(pingTimer);
            const reason = reasonBuf ? reasonBuf.toString() : '';
            const delay = Math.min(30_000, 1000 * Math.pow(2, attempt++));
            console.warn(`[${name}] closed code=${code} reason="${reason}". Reconnecting in ${delay}ms`);
            setTimeout(() => connect(onEvent), delay);
        });

        ws.on('error', (err) => {
            console.error(`[${name}] ws error:`, err?.message || err);
        });
    }

    return { name, start: connect };
}

function createBinanceAdapter() {
    const name = 'binance';
    const url  = 'wss://fstream.binance.com/ws/!forceOrder@arr';

    let attempt = 0;
    let pingTimer = null;
    let ws = null;

    function connect(onEvent) {
        ws = new WebSocket(url);

        ws.on('open', () => {
            attempt = 0;
            console.log(`[${name}] connected`);
            pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 60_000);
        });

        ws.on('message', (msg) => {
            try {
                const evt = JSON.parse(msg);
                const o = evt.o || {};

                // Prefer cumulative filled qty/avg price, then fallbacks
                const qty   = parseFloat(o.z ?? o.q ?? o.l ?? '0');
                const price = parseFloat(o.ap ?? o.p ?? '0');
                if (!qty || !price) return;

                const notional = qty * price;
                if (notional < MIN_NOTIONAL_USD) return;

                // SELL = liquidated Long (forced sell). BUY = liquidated Short (forced buy)
                const side = o.S === 'SELL' ? 'Long' : 'Short';

                // Normalize symbol to remove quote asset suffix (USDT/USDC)
                const rawSym = (o.s || '');
                const symbol = rawSym.replace(/(USDT|USDC)$/i, '');

                const norm = {
                    exchange: name,
                    ts: evt.E || Date.now(),
                    symbol,
                    side,           // 'Long' or 'Short'
                    price,
                    qty,
                    notional,
                    raw: evt,       // optional for debugging
                };
                onEvent(norm);
            } catch (e) {
                console.error(`[${name}] parse error:`, e.message);
            }
        });

        ws.on('close', () => {
            if (pingTimer) clearInterval(pingTimer);
            const delay = Math.min(30_000, 1000 * Math.pow(2, attempt++)); // 1s,2s,4s,...30s
            console.log(`[${name}] closed. Reconnecting in ${delay}ms`);
            setTimeout(() => connect(onEvent), delay);
        });

        ws.on('error', (err) => {
            console.error(`[${name}] ws error:`, err.message);
        });
    }

    return { name, start: connect };
}

// TODO: Example skeleton for another exchange (copy & adapt):
/*
function createBybitAdapter() {
  const name = 'bybit';
  const url = 'wss://stream.bybit.com/v5/public/linear'; // example; adapt as needed

  function connect(onEvent) {
    // open ws, subscribe to liquidation topic, normalize to {exchange, symbol, side, price, qty, notional, ts}
    // onEvent(norm);
  }

  return { name, start: connect };
}
*/


const ADAPTERS = [
    createBinanceAdapter(),
    createBybitAdapter({ symbols: ['BTCUSDT','ETHUSDT','SOLUSDT'] }), // add the ones you want
    // createOkxAdapter(),
];

for (const adapter of ADAPTERS) {
    adapter.start((evt) => {
        try {
            const line = formatLine(evt);
            if (!line) return;

            sendTelegram(line);
        } catch (e) {
            console.error(`[${adapter.name}] format/send error:`, e.message);
        }
    });
}

console.log('Liquidation streamer started for:', ADAPTERS.map(a => a.name).join(', '));
