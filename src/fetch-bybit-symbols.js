import { fetch } from 'undici';

const BYBIT_BASE_URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';

export async function fetchBybitSymbols({
                                            category = 'linear',
                                            quote = 'USDT',
                                            baseCoins = null,
                                            status = 'Trading',
                                            limit = 1000,
                                        } = {}) {
    const out = [];
    let cursor = undefined;

    for (;;) {
        const url = new URL('/v5/market/instruments-info', BYBIT_BASE_URL);
        url.searchParams.set('category', category);
        url.searchParams.set('limit', String(limit));
        if (cursor) url.searchParams.set('cursor', cursor);

        const r = await fetch(url, { method: 'GET' });
        if (!r.ok) throw new Error(`Bybit instruments-info ${r.status}`);
        const body = await r.json();

        const list = body?.result?.list ?? [];
        for (const it of list) {
            // it.symbol, it.status, it.baseCoin, it.quoteCoin
            if (status && it.status !== status) continue;
            if (baseCoins && !baseCoins.includes(it.baseCoin)) continue;
            if (quote && it.quoteCoin !== quote) continue;
            if (it.symbol) out.push(it.symbol);
        }

        const next = body?.result?.nextPageCursor;
        if (!next) break;
        cursor = next;
    }

    return Array.from(new Set(out)).sort();
}
