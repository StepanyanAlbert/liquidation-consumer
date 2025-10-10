

import WebSocket from 'ws';

const NAME = 'hyperliquid';
const URL  = process.env.HL_WS_URL || 'wss://api.hyperliquid.xyz/ws';
const USER = process.env.HL_USER || '<YOUR_ADDRESS>';
const MIN_NOTIONAL_USD = Number(process.env.MIN_NOTIONAL_USD || 10);

function connect() {
    let ws, attempt = 0, jsonPing;

    const subscribe = () => {
        // userFills (include liquidation field on WsFill)
        ws.send(JSON.stringify({
            method: 'subscribe',
            subscription: { type: 'userFills', user: USER, aggregateByTime: false }
        }));
        // userEvents (includes WsLiquidation objects)
        ws.send(JSON.stringify({
            method: 'subscribe',
            subscription: { type: 'userEvents', user: USER }
        }));
    };

    const handleUserFills = (msg) => {
        // msg.data: array of WsFill
        const fills = Array.isArray(msg.data) ? msg.data : [];
        for (const f of fills) {
            if (!f?.liquidation) continue; // only interested in liquidation fills
            const coin = String(f.coin || '');
            const px   = Number(f.px || 0);
            const sz   = Math.abs(Number(f.sz || 0)); // size can be signed
            const notional = px * sz;
            if (!px || !sz || notional < MIN_NOTIONAL_USD) continue;

            // map side for display
            // f.side is usually "B" / "S" or string; adapt if needed
            const side = (String(f.side).toLowerCase().startsWith('b')) ? 'Long' : 'Short';

            const method = f.liquidation.method; // "market" | "backstop"
            const markPx = f.liquidation.markPx;

            const line =
                `${side === 'Long' ? '🟢' : '🔴'}  Hyperliquid  ` +
                `#${coin} Liquidated ${side}: $${Math.round(notional).toLocaleString()} at $${px.toFixed(2)} ` +
                `(method=${method}, mark=${markPx})`;

            process.send?.({
                type: 'event',
                exchange: NAME,
                payload: {
                    ts: f.time || Date.now(),
                    symbol: coin,
                    side,
                    price: px,
                    qty: sz,
                    notional,
                    method,
                    markPx
                },
                line
            });
        }
    };

    const handleUserEvents = (msg) => {
        // msg.data: WsUserEvent or array thereof; filter WsLiquidation items if present
        const items = Array.isArray(msg.data) ? msg.data : [msg.data];
        for (const it of items) {
            if (!it) continue;
            // Some payloads are discriminated unions; you may need to check a type field.
            // If WsLiquidation shape is present:
            if (it.lid && it.liquidated_user) {
                process.send?.({
                    type: 'log',
                    exchange: NAME,
                    msg: `WsLiquidation: lid=${it.lid} liquidated_user=${it.liquidated_user} ntl=${it.liquidated_ntl_pos}`
                });
            }
        }
    };

    const handleMessage = (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) {
            return console.error(`[${NAME}] parse error:`, e.message);
        }

        // Hyperliquid format:
        // { method:'subscription', subscription:{type:'userFills'|...}, data: ..., isSnapshot?:true }
        if (!msg || !msg.subscription || !msg.subscription.type) return;
        const t = msg.subscription.type;

        // Optionally ignore snapshots if you only want live:
        // if (msg.isSnapshot) return;

        if (t === 'userFills') return handleUserFills(msg);
        if (t === 'userEvents') return handleUserEvents(msg);
    };

    const open = () => {
        attempt = 0;
        console.log(`[${NAME}] connected`);
        subscribe();
        // JSON keepalive (Hyperliquid expects the subscribe-style protocol; if they require ping messages, add them here)
        jsonPing = setInterval(() => {
            try { ws.send(JSON.stringify({ method: 'ping' })); } catch {}
        }, 20_000);
    };

    const close = (code, reasonBuf) => {
        if (jsonPing) clearInterval(jsonPing);
        const reason = reasonBuf ? reasonBuf.toString() : '';
        const delay = Math.min(30_000, 1000 * Math.pow(2, attempt++));
        console.warn(`[${NAME}] closed code=${code} reason="${reason}". Reconnecting in ${delay}ms`);
        setTimeout(connect, delay);
    };

    ws = new WebSocket(URL);
    ws.on('open', open);
    ws.on('message', handleMessage);
    ws.on('close',  close);
    ws.on('error', (err) => console.error(`[${NAME}] ws error:`, err?.message || err));
}

// start as child
connect();
