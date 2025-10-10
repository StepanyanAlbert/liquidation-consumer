import WebSocket from 'ws';
import { num, buildLiquidationLine } from '../utils.js';

const NAME = 'Gate';
const WS_URL =  'wss://fx-ws.gateio.ws/v4/ws/usdt';

const SUB_PAYLOAD = ['!all'];
const MIN_NOTIONAL = Number(process.env.MIN_NOTIONAL_USD || 1000);

function computeNotionalUSD(contract, sizeRaw, priceRaw) {
    const size = Math.abs(num(sizeRaw));
    const px   = num(priceRaw);

    if (!size) return 0;

    if (/_USDT$/i.test(contract)) {
        if (!px) return 0;
        return size * px;
    }
    return size;
}

function normalizeSymbol(contract) {
    return String(contract || '').replace(/_(USDT|USD)$/i, '');
}

function sideFromSize(sizeRaw) {
    const s = num(sizeRaw);
    return s < 0 ? 'Long' : 'Short';
}

function start() {
    let ws;
    let pingTimer = null;
    let attempt = 0;

    const subscribe = () => {
        const sub = {
            time: Math.floor(Date.now() / 1000),
            channel: 'futures.public_liquidates',
            event: 'subscribe',
            payload: SUB_PAYLOAD,
        };
        try {
            ws.send(JSON.stringify(sub));
            process.send?.({ type: 'log', exchange: NAME, msg: `subscribe sent: ${JSON.stringify(sub)}` });
        } catch (e) {
            process.send?.({ type: 'log', exchange: NAME, level: 'error', msg: `subscribe send error: ${e.message}` });
        }
    };

    const onOpen = () => {
        attempt = 0;
        process.send?.({ type: 'log', exchange: NAME, msg: 'connected' });
        subscribe();
        pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 60_000);
    };

    const onMessage = (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            process.send?.({ type:'log', exchange: NAME, level:'error', msg:`parse error: ${e.message}` });
            return;
        }

        if (msg?.event === 'subscribe') {
            process.send?.({ type:'log', exchange: NAME, msg:'subscribe ack' });
            return;
        }
        if (msg?.event === 'error') {
            process.send?.({ type:'log', exchange: NAME, level:'error', msg:`sub error: ${JSON.stringify(msg)}` });
            return;
        }

        if (!(msg?.channel === 'futures.public_liquidates' && msg?.event === 'update')) return;

        const items = Array.isArray(msg.result) ? msg.result : (msg.result ? [msg.result] : []);
        if (items.length === 0) return;

        for (const row of items) {
            const contract = String(row.contract || '');
            const symbol   = normalizeSymbol(contract);
            const price    = num(row.price);
            const size     = Number(row.size);
            const side     = sideFromSize(size);
            const absSize  = Math.abs(size);

            const notional = computeNotionalUSD(contract, absSize, price); // ensure this returns > 0

            if (!notional || notional < MIN_NOTIONAL) {
                // Optional debug to see what’s being dropped
                // process.send?.({ type:'log', exchange: NAME, msg:`skip ${contract} notional=${notional}` });
                continue;
            }

            const line = buildLiquidationLine({
                exchange: NAME.toUpperCase(),
                symbol,
                side,
                notional,
                price
            });

            process.send?.({
                type: 'event',
                exchange: NAME,
                line,
                notional
            });
        }
    };

    const onClose = (code, reasonBuf) => {
        if (pingTimer) clearInterval(pingTimer);
        const reason = reasonBuf ? reasonBuf.toString() : '';
        const delay = Math.min(30_000, 1000 * Math.pow(2, attempt++));
        process.send?.({ type:'log', exchange: NAME, msg:`closed code=${code} reason="${reason}". Reconnecting in ${delay}ms` });
        setTimeout(connect, delay);
    };

    const onError = (err) => {
        process.send?.({ type:'log', exchange: NAME, level:'error', msg: err?.message || String(err) });
    };

    function connect() {
        ws = new WebSocket(WS_URL);
        ws.on('open', onOpen);
        ws.on('message', onMessage);
        ws.on('close', onClose);
        ws.on('error', onError);
    }

    connect();
}

start();
