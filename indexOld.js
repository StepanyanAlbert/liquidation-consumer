const WebSocket = require('ws');

// --------- Config ---------
const WS_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const MIN_NOTIONAL_USD = 10000;

const BOT_TOKEN= process.env.BOT_TOKEN
const CHAT_ID= process.env.CHAT_ID


if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing BOT_TOKEN or CHAT_ID env vars');
  process.exit(1);
}

const queue = [];
let sending = false;
const SEND_INTERVAL_MS = 250; // ~4 msgs/sec; tune to your needs

async function sendTelegram(text) {
  queue.push(text);
  if (!sending) {
    sending = true;
    (async function drain() {
      const item = queue.shift();
      if (item) {
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: CHAT_ID,
              text: item,
              disable_web_page_preview: true
            })
          });
        } catch (e) {
          console.error('Telegram send error:', e.message);
        }
        setTimeout(drain, SEND_INTERVAL_MS);
      } else {
        sending = false;
      }
    })();
  }
}

function fmtNotional(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(2);
}

function makeLine(o) {
  const qty = parseFloat(o.q ?? o.l ?? '0');
  const price = parseFloat(o.p ?? o.ap ?? '0');
  const notional = qty * price;

  if (!qty || !price || notional < MIN_NOTIONAL_USD) return null;

  const isSell = o.S === 'SELL'; // SELL = liquidated long, BUY = liquidated short
  const emoji = !isSell ? '🟢' : '🔴';
  const side = isSell ? 'Long' : 'Short';
  const symbol = (o.s || '').replace(/USDT$/i, ''); // BTCUSDT → BTC

  return `${emoji} - Binance -  #${symbol} Liquidated ${side}: $${fmtNotional(notional)} at $${price.toFixed(2)}`;
}

function start() {
  const ws = new WebSocket(WS_URL);

  let pingTimer = null;

  ws.on('open', () => {
    console.log('Connected:', WS_URL);
    // Optional keepalive ping (server pings every ~3 min; client can also ping)
    pingTimer = setInterval(() => {
      try { ws.ping(); } catch {}
    }, 60_000);
  });

  ws.on('message', (msg) => {
    try {
      const evt = JSON.parse(msg);
      const o = evt.o || {};

      const line = makeLine(o);
      if (line) {
        console.log(line);
        sendTelegram(line);
      }
    } catch (e) {
      console.error('Message parse error:', e.message);
    }
  });

  ws.on('close', () => {
    if (pingTimer) clearInterval(pingTimer);
    console.log('Closed. Reconnecting in 2s...');
    setTimeout(start, 2000); // auto-reconnect
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
  });
}

start();

