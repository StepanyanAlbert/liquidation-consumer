'use strict';

const WebSocket = require('ws');

// ----- Config -----
const NAME = 'bybit';
const URL  = 'wss://stream.bybit.com/v5/public/linear';

// Read env (fall back to defaults)
const MIN_NOTIONAL_USD = Number(process.env.MIN_NOTIONAL_USD || 100);

// Allow passing symbols via env (comma-separated), or parent can inject via fork env
// e.g. BYBIT_SYMBOLS="BTCUSDT,ETHUSDT,SOLUSDT"
const SYM_ENV = (process.env.BYBIT_SYMBOLS || '').trim();
const SYMBOLS = SYM_ENV
    ? SYM_ENV.split(',').map(s => s.trim()).filter(Boolean)
    : []; // empty → warn (Bybit needs per-symbol topics)

if (!Array.isArray(SYMBOLS) || SYMBOLS.length === 0) {
    console.warn(`[${NAME}] No symbols provided. Bybit requires per-symbol subscriptions like allLiquidation.BTCUSDT`);
}
const ARGS = SYMBOLS.map(s => `allLiquidation.${String(s).toUpperCase()}`);

function connect() {
    let ws;
    let attempt = 0;
    let pingTimer = null;

    const subscribe = () => {
        if (ARGS.length === 0) return;
        const sub = { op: 'subscribe', args: ARGS };
        console.log(`[${NAME}] sending subscribe: ${JSON.stringify(sub)}`);
        try {
            ws.send(JSON.stringify(sub));
        } catch (e) {
            console.error(`[${NAME}] subscribe send error:`, e.message);
        }
    };

    const handleEventRow = (msg, row) => {
        console.log(row)
        const rawSym = String(row.s || '');
        const symbol = rawSym.replace(/(USDT|USDC)$/i, '');
        const sideStr = row.S; // 'Buy' means long got liquidated, 'Sell' means short got liquidated
        const side = sideStr === 'Buy' ? 'Long' : 'Short';

        const qty   = parseFloat(row.v ?? '0');
        const price = parseFloat(row.p ?? '0');
        if (!qty || !price) return;

        const notional = qty * price;
        if (notional < MIN_NOTIONAL_USD) return;

        const ts = row.T || msg.ts || Date.now();

        // Send normalized event to parent
        process.send?.({
            type: 'event',
            exchange: NAME,
            payload: {
                ts,
                symbol,
                side,         // 'Long' | 'Short'
                price,
                qty,
                notional
            },
            // Optional display line (so parent can just forward)
            line: `${side === 'Long' ?  '🔴': '🟢' }  Bybit  #${symbol} Liquidated ${side}: $${Math.round(notional).toLocaleString()} at $${price.toFixed(2)}`
        });
    };

    const handleMessage = (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            console.error(`[${NAME}] JSON parse error:`, e.message, 'raw=', String(raw).slice(0, 300));
            return;
        }

        // Ping/Pong protocol (JSON). Note: TCP-level pings also used below.
        if (msg.op === 'ping') {
            const pong = msg.ts ? { op: 'pong', ts: msg.ts } : { op: 'pong' };
            try { ws.send(JSON.stringify(pong)); } catch (e) {
                console.error(`[${NAME}] failed to send pong:`, e.message);
            }
            return;
        }

        // Subscription ack / errors
        if (Object.prototype.hasOwnProperty.call(msg, 'success')) {
            console.log(`[${NAME}] subscribe ack: success=${msg.success} retMsg=${msg.retMsg || ''} code=${msg.code || ''}`);
            if (msg.success === false) {
                console.error(`[${NAME}] subscription failed: ${JSON.stringify(msg)}`);
            }
            return;
        }

        // Data messages: topic like "allLiquidation.BTCUSDT"
        const topic = typeof msg.topic === 'string' ? msg.topic : '';
        if (!/^allLiquidation\./.test(topic)) return;
        if (!Array.isArray(msg.data)) return;

        for (const row of msg.data) handleEventRow(msg, row);
    };

    const open = () => {
        attempt = 0;
        console.log(`[${NAME}] connected`);
        subscribe();
        // Transport keepalive (Bybit also does JSON ping/pong above)
        pingTimer = setInterval(() => {
            try { ws.ping(); } catch (e) {
                console.error(`[${NAME}] ping error:`, e.message);
            }
        }, 60_000);
    };

    const close = (code, reasonBuf) => {
        if (pingTimer) clearInterval(pingTimer);
        const reason = reasonBuf ? reasonBuf.toString() : '';
        const delay = Math.min(30_000, 1000 * Math.pow(2, attempt++));
        console.warn(`[${NAME}] closed code=${code} reason="${reason}". Reconnecting in ${delay}ms`);
        setTimeout(connect, delay);
    };

    ws = new WebSocket(URL);
    ws.on('open',   open);
    ws.on('message', handleMessage);
    ws.on('close',  close);
    ws.on('error', (err) => {
        console.error(`[${NAME}] ws error:`, err?.message || err);
    });
}

connect();
