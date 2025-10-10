import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import dotenv from 'dotenv';
import path from 'path';
import {fetchBybitSymbols} from "./fetch-bybit-symbols.js";

dotenv.config();


const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const ENABLE_TG  = process.env.ENABLE_TELEGRAM === '1';
const ENABLE_X   = process.env.ENABLE_X === '1';

function spawnAdapter(name, file, extraEnv={}) {
    const child = fork(path.resolve(__dirname, 'adapters', file), {
        env: { ...process.env, EXCHANGE:name, ...extraEnv },
        stdio: ['inherit','inherit','inherit','ipc']
    });

    child.on('message', async (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'log') {
            const level = msg.level || 'info';
            console[level]?.(`[${name}] ${msg.msg}`) || console.log(`[${name}] ${msg.msg}`);
        } else if (msg.type === 'event' && msg.line) {
            if (ENABLE_TG) {
                const { sendTelegram } = await import('./telegram.js');
                sendTelegram({ text: msg.line, notional: msg.notional, exhcange: name });
            }
            if (ENABLE_X) {
                const { tweetLiquidation } = await import('./tweet.js');
                if ( msg.notional > process.env.MIN_NOTIONAL_USD){
                    tweetLiquidation({
                        text: msg.line,
                        notional: msg.notional,
                        exchange: name,
                    });
                }

            }
        }
    });

    child.on('exit', (code, signal) => {
        console.error(`[${name}] exited: code=${code} signal=${signal}. Restarting in 2s...`);
        setTimeout(() => spawnAdapter(name, file, extraEnv), 2000);
    });

    return child;
}
const bybitSymbols = await fetchBybitSymbols({
    category: 'linear',
    quote: 'USDT'
});

const symbolCsv = bybitSymbols.length ? bybitSymbols.join(',') : (process.env.BYBIT_SYMBOLS || '');

spawnAdapter('binance', 'binance.js');
spawnAdapter('bybit',   'bybit.js', { BYBIT_SYMBOLS: symbolCsv });
spawnAdapter('okx',   'okx.js');
spawnAdapter('gateio',   'gateio.js');

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
