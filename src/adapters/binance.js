import WebSocket from 'ws';
import { num, buildLiquidationLine } from '../utils.js';

const WS_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const MIN_NOTIONAL = Number(process.env.MIN_NOTIONAL_USD || 100);

function fmt(n, d=2){ return Number(n).toFixed(d); }

function normalizeBinance(o) {
    const qty   = num(o.z ?? o.q ?? o.l);
    const price = num(o.ap ?? o.p);
    const notional = qty * price;

    const isSell = o.S === 'SELL'; // SELL => liquidated LONG
    const symbol = String(o.s || '').replace(/(USDT|USDC)$/i, '');

    return {
        exchange: 'Binance',
        symbol,
        side: isSell ? 'Long' : 'Short',
        qty,
        price,
        notional,
        ts: num(o.T || o.E || Date.now()),
    };
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
                const norm = normalizeBinance(o);

                if (!norm.qty || !norm.price || norm.notional < MIN_NOTIONAL) return;

                const line = buildLiquidationLine(norm);
                if (line) process.send?.({
                    type: 'event',
                    exchange: 'binance',
                    line,
                    notional: norm.notional,
                });
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
