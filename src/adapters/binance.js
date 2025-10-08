const WebSocket = require('ws');

const WS_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const MIN_NOTIONAL = Number(process.env.MIN_NOTIONAL_USD || 100);

function fmt(n, d=2){ return Number(n).toFixed(d); }

function fmtNotional(v) {
    if (v >= 1e9) return (v/1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v/1e3).toFixed(0) + 'K';
    return v.toFixed(0);
}
function makeLine(o) {
    const qty   = parseFloat(o.z ?? o.q ?? o.l ?? '0');
    const price = parseFloat(o.ap ?? o.p ?? '0');
    const notional = qty * price;
    if (!qty || !price || notional < MIN_NOTIONAL) return null;
    const isSell = o.S === 'SELL';
    const emoji = isSell ?  '🔴' : '🟢';
    const side = isSell ? 'Long' : 'Short';
    const symbol = (o.s || '').replace(/USDT$/i,'');
    return `${emoji}  Binance  #${symbol} Liquidated ${side}: $${fmtNotional(notional)} at $${price.toFixed(2)}`;
}

function start() {
    let ws, pingTimer;
    const connect = () => {
        ws = new WebSocket(WS_URL);
        ws.on('open', () => {
            process.send?.({ type:'log', exchange:'binance', msg:'connected' });
            pingTimer = setInterval(() => { try{ ws.ping(); }catch{} }, 60_000);
        });
        ws.on('message', (msg) => {
            try {
                const evt = JSON.parse(msg);
                const o = evt.o || {};
                const line = makeLine(o);
                if (line) process.send?.({ type:'event', exchange:'binance', line });
            } catch (e) {
                process.send?.({ type:'log', exchange:'binance', level:'error', msg:e.message });
            }
        });
        ws.on('close', () => {
            if (pingTimer) clearInterval(pingTimer);
            process.send?.({ type:'log', exchange:'binance', msg:'closed, reconnecting...' });
            setTimeout(connect, 1000);
        });
        ws.on('error', (err) => {
            process.send?.({ type:'log', exchange:'binance', level:'error', msg:err.message });
        });
    };
    connect();
}
start();
