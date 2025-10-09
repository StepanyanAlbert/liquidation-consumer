require('dotenv').config();

const { fork } = require('child_process');
const path = require('path');
const { sendTelegram } = require('./telegram');
const { tweetLiquidation } = require('./tweet');

const ENABLE_TG  = process.env.ENABLE_TELEGRAM === '1';
const ENABLE_X   = process.env.ENABLE_X === '1';

function spawnAdapter(name, file, extraEnv={}) {
    const child = fork(path.resolve(__dirname, 'adapters', file), {
        env: { ...process.env, EXCHANGE:name, ...extraEnv },
        stdio: ['inherit','inherit','inherit','ipc']
    });

    child.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'log') {
            const level = msg.level || 'info';
            console[level]?.(`[${name}] ${msg.msg}`) || console.log(`[${name}] ${msg.msg}`);
        } else if (msg.type === 'event' && msg.line) {
            if (ENABLE_TG) {
                sendTelegram(msg.line);
            }
            if (ENABLE_X) {
                tweetLiquidation({
                    text: msg.line,
                    notional: Number(msg.notional) || 0,
                    exchange: name,
                });
            }
        }
    });

    child.on('exit', (code, signal) => {
        console.error(`[${name}] exited: code=${code} signal=${signal}. Restarting in 2s...`);
        setTimeout(() => spawnAdapter(name, file, extraEnv), 2000);
    });

    return child;
}

// Start all exchanges you want:
spawnAdapter('binance', 'binance.js');
spawnAdapter('bybit',   'bybit.js');

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
