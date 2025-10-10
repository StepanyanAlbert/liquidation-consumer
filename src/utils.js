export function fmtNotional(v) {
    const n = Number(v || 0);
    if (n >= 1e9)  return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3)  return (n / 1e3).toFixed(0) + 'K';
    return n.toFixed(2);
}

export function num(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
}

export function buildLiquidationLine({ exchange, symbol, side, notional, price }) {
    const emoji = side === 'Long' ? '🔴' : '🟢';
    const notStr = fmtNotional(notional);
    const pxStr  = Number(price || 0).toLocaleString(undefined, { maximumFractionDigits: 10 });
    return `${emoji}  ${exchange}  #${symbol} Liquidated ${side}: $${notStr} at $${pxStr}`;
}
