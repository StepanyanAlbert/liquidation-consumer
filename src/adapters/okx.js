'use strict';

const WebSocket = require('ws');
const https = require('https');
const { num, buildLiquidationLine, MIN_NOTIONAL } = require('../utils');

const WS_URL = 'wss://ws.okx.com/ws/v5/public';
const REST_BASE = 'https://www.okx.com/api/v5/public/instruments?instType=';
const REFRESH_MS = 30 * 60 * 1000; // refresh instrument specs every 30m

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function fetchInstrumentsFor(type) {
    const url = REST_BASE + type; // SWAP or FUTURES
    const json = await httpGetJson(url);
    if (!json || !Array.isArray(json.data)) return [];
    return json.data.map(it => ({
        instId: it.instId,
        instFamily: it.instFamily || it.uly || '',
        uly: it.uly || '',
        ctVal: parseFloat(it.ctVal ?? '0'),
        ctValCcy: String(it.ctValCcy || '')
    }));
}

async function loadAllInstruments() {
    const [swap, fut] = await Promise.allSettled([
        fetchInstrumentsFor('SWAP'),
        fetchInstrumentsFor('FUTURES')
    ]);

    const map = new Map();

    const put = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const it of arr) {
            map.set(it.instId, it);
        }
    };

    if (swap.status === 'fulfilled') put(swap.value);
    if (fut.status === 'fulfilled')  put(fut.value);

    return map;
}

/**
 * OKX size -> USD notional
 * - If ctValCcy === 'USDT': notional = sz * ctVal (already in USDT)
 * - Else: notional = sz * ctVal * bkPx
 */
function computeNotionalUSD({ detail, instMeta }) {
    const sz = parseFloat(detail.sz ?? '0');
    const bkPx = parseFloat(detail.bkPx ?? '0');

    if (!instMeta || !sz || (!bkPx && instMeta.ctValCcy !== 'USDT')) return 0;

    if (instMeta.ctValCcy === 'USDT') {
        const notional = sz * (instMeta.ctVal || 0);
        return Number.isFinite(notional) ? notional : 0;
    }
    const notional = sz * (instMeta.ctVal || 0) * bkPx;
    return Number.isFinite(notional) ? notional : 0;
}

function start() {
    let ws;
    let pingTimer = null;
    let refreshTimer = null;
    let instruments = new Map();

    async function refreshInstruments() {
        try {
            instruments = await loadAllInstruments();
            process.send?.({ type:'log', exchange:'okx', msg:`instrument map loaded: ${instruments.size}` });
        } catch (e) {
            process.send?.({ type:'log', exchange:'okx', level:'error', msg:`instrument load failed: ${e.message}` });
        }
    }

    const subscribe = () => {
        const subs = [
            { channel: 'liquidation-orders', instType: 'SWAP' },
            { channel: 'liquidation-orders', instType: 'FUTURES' },
        ];
        ws.send(JSON.stringify({ id:'liqSwap',   op:'subscribe', args:[ subs[0] ] }));
        ws.send(JSON.stringify({ id:'liqFuture', op:'subscribe', args:[ subs[1] ] }));
    };

    const connect = async () => {
        await refreshInstruments();

        ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            process.send?.({ type:'log', exchange:'okx', msg:'connected' });
            subscribe();
            pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 60_000);

            if (refreshTimer) clearInterval(refreshTimer);
            refreshTimer = setInterval(refreshInstruments, REFRESH_MS);
        });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);

                if (msg?.event === 'subscribe' || msg?.op === 'subscribe') {
                    process.send?.({ type:'log', exchange:'okx', msg:'subscribe ack' });
                    return;
                }
                if (msg?.event === 'error') {
                    process.send?.({ type:'log', exchange:'okx', level:'error', msg:`sub error: ${JSON.stringify(msg)}` });
                    return;
                }
                if (!msg || !Array.isArray(msg.data)) return;

                // liquidation-orders payload
                for (const row of msg.data) {
                    const instId = row.instId; // e.g. BTC-USDT-SWAP
                    const meta = instruments.get(instId);
                    const family = row.instFamily || row.uly || instId || '';
                    const symbol = (family.split('-')[0] || '').toUpperCase();

                    if (!Array.isArray(row.details)) continue;

                    for (const d of row.details) {
                        // OKX: side 'sell' => liquidated Long, 'buy' => Short
                        const side = d.side === 'sell' ? 'Long' : 'Short';
                        const price = num(d.bkPx);
                        const notional = computeNotionalUSD({ detail: d, instMeta: meta });
                        if (!notional || notional < MIN_NOTIONAL) continue;

                        // Normalize event
                        const norm = {
                            exchange: 'OKX',
                            symbol,
                            side,               // 'Long' | 'Short'
                            price,              // raw (no rounding)
                            qty: num(d.sz),     // contracts
                            notional,           // USD
                            ts: num(d.ts) || Date.now(),
                        };

                        const line = buildLiquidationLine(norm);

                        process.send?.({
                            type: 'event',
                            exchange: 'okx',
                            line,
                            notional: norm.notional,
                        });
                    }
                }
            } catch (e) {
                process.send?.({ type:'log', exchange:'okx', level:'error', msg:`parse: ${e.message}` });
            }
        });

        ws.on('close', () => {
            if (pingTimer) clearInterval(pingTimer);
            if (refreshTimer) clearInterval(refreshTimer);
            process.send?.({ type:'log', exchange:'okx', msg:'closed, reconnecting...' });
            setTimeout(connect, 1000);
        });

        ws.on('error', (err) => {
            process.send?.({ type:'log', exchange:'okx', level:'error', msg: err.message });
        });
    };

    connect();
}

start();
