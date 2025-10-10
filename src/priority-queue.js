export class PriorityQueue {
    constructor({
        capacity = Infinity,
        getPriority = (item) => item?.priority ?? 0,
        tieBreaker = (a, b) => b.ts - a.ts,
    } = {}) {
        this._a = [];
        this._cap = capacity;
        this._getP = getPriority;
        this._tie = tieBreaker;
    }

    size() { return this._a.length; }
    isEmpty() { return this._a.length === 0; }
    peek() { return this._a[0]; }
    clear() { this._a = []; }

    toArray() { return [...this._a].sort((x, y) => this._cmp(y, x)); }

    enqueue(item) {
        const pr = this._getP(item) ?? 0;
        item.__p = pr;

        if (this._a.length < this._cap) {
            this._push(item);
            return { added: true, dropped: null };
        }

        // at capacity: if new is better than smallest, replace smallest
        const smallestIdx = this._smallestIndex();
        const smallest = this._a[smallestIdx];
        if (this._cmp(item, smallest) > 0) {
            this._a[smallestIdx] = item;
            this._heapifyUp(smallestIdx);
            this._heapifyDown(smallestIdx);
            return { added: true, dropped: smallest };
        }
        return { added: false, dropped: item }; // rejected
    }

    dequeue() {
        if (this._a.length === 0) return undefined;
        const top = this._a[0];
        const last = this._a.pop();
        if (this._a.length > 0) {
            this._a[0] = last;
            this._heapifyDown(0);
        }
        return top;
    }

    // ----- internals -----
    _cmp(a, b) {
        const pa = a.__p ?? this._getP(a) ?? 0;
        const pb = b.__p ?? this._getP(b) ?? 0;
        if (pa !== pb) return pa - pb; // max-heap: higher priority wins
        return -this._tie(a, b);       // reverse because we’re doing “a>b?”
    }

    _push(x) {
        this._a.push(x);
        this._heapifyUp(this._a.length - 1);
    }

    _heapifyUp(i) {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this._cmp(this._a[i], this._a[p]) <= 0) break;
            [this._a[i], this._a[p]] = [this._a[p], this._a[i]];
            i = p;
        }
    }

    _heapifyDown(i) {
        for (;;) {
            const l = (i << 1) + 1;
            const r = l + 1;
            let best = i;
            if (l < this._a.length && this._cmp(this._a[l], this._a[best]) > 0) best = l;
            if (r < this._a.length && this._cmp(this._a[r], this._a[best]) > 0) best = r;
            if (best === i) break;
            [this._a[i], this._a[best]] = [this._a[best], this._a[i]];
            i = best;
        }
    }

    _smallestIndex() {
        // In a max-heap, the smallest element is among the leaves.
        // For simplicity & speed with small queues, do a linear scan.
        let idx = 0, minIdx = 0;
        let min = this._a[0];
        for (idx = 1; idx < this._a.length; idx++) {
            if (this._cmp(this._a[idx], min) < 0) {
                min = this._a[idx];
                minIdx = idx;
            }
        }
        return minIdx;
    }
}
