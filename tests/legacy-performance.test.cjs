const assert = require('assert');
const Performance = require('./support/performance.cjs');

function rows(symbolStart, prices) {
  const start = new Date(symbolStart + 'T00:00:00Z');
  return prices.map((price, index) => {
    const day = new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10);
    return { date: day, close: price, adjustedClose: price };
  });
}

(function longPositionBalance() {
  const state = {
    trades: [{ id: 'b1', symbol: 'AAA', side: 'buy', qty: 10, price: 100, fee: 0, time: '2026-01-01T12:00:00Z' }],
    history: { AAA: rows('2026-01-01', [100, 105, 110]) },
    quotes: { AAA: { price: 110, marketDataAt: '2026-01-03' } },
    splits: {},
  };
  const result = Performance.series(state, { range: 'ALL', symbol: 'ALL' });
  assert.strictEqual(result.points.at(-1).balance, 100);
  assert.strictEqual(result.events.length, 1);
  assert.strictEqual(result.events[0].balanceAfter, 0);
})();

(function buyThenPartialSell() {
  const state = {
    trades: [
      { id: 's1', symbol: 'AAA', side: 'sell', qty: 5, price: 120, fee: 0, time: '2026-01-03T12:00:00Z' },
      { id: 'b1', symbol: 'AAA', side: 'buy', qty: 10, price: 100, fee: 0, time: '2026-01-01T12:00:00Z' },
    ],
    history: { AAA: rows('2026-01-01', [100, 110, 120, 125]) },
    quotes: { AAA: { price: 125, marketDataAt: '2026-01-04' } },
    splits: {},
  };
  const result = Performance.series(state, { range: 'ALL', symbol: 'AAA' });
  assert.strictEqual(result.points.at(-1).balance, 225); // -1000 + 600 + 5*125
  assert.strictEqual(result.events.length, 2);
  assert.strictEqual(result.events[1].side, 'sell');
})();

(function shortPositionBalance() {
  const state = {
    trades: [{ id: 's1', symbol: 'BBB', side: 'sell', qty: 4, price: 50, fee: 0, time: '2026-01-01T12:00:00Z' }],
    history: { BBB: rows('2026-01-01', [50, 45, 40]) },
    quotes: { BBB: { price: 40, marketDataAt: '2026-01-03' } },
    splits: {},
  };
  const result = Performance.series(state, { range: 'ALL', symbol: 'ALL' });
  assert.strictEqual(result.points.at(-1).balance, 40); // +200 - 4*40
})();

(function splitAdjustedTradeQuantity() {
  const state = {
    trades: [{ id: 'b1', symbol: 'SPLT', side: 'buy', qty: 1, price: 100, fee: 0, time: '2026-01-01T12:00:00Z' }],
    history: { SPLT: [
      { date: '2026-01-01', close: 100, adjustedClose: 50 },
      { date: '2026-01-02', close: 50, adjustedClose: 50 },
      { date: '2026-01-03', close: 60, adjustedClose: 60 },
    ] },
    quotes: { SPLT: { price: 60, marketDataAt: '2026-01-03' } },
    splits: { SPLT: [{ effectiveDate: '2026-01-02', factor: 2 }] },
  };
  const result = Performance.series(state, { range: 'ALL', symbol: 'ALL' });
  assert.strictEqual(result.points[0].balance, 0); // -100 + 2*50
  assert.strictEqual(result.points.at(-1).balance, 20); // -100 + 2*60
})();

(function symbolFilterAndRanges() {
  const state = {
    trades: [
      { id: 'a', symbol: 'AAA', side: 'buy', qty: 1, price: 10, fee: 0, time: '2026-01-01T00:00:00Z' },
      { id: 'b', symbol: 'BBB', side: 'buy', qty: 1, price: 20, fee: 0, time: '2026-01-01T00:00:00Z' },
    ],
    history: { AAA: rows('2026-01-01', [10, 15]), BBB: rows('2026-01-01', [20, 10]) },
    quotes: {}, splits: {},
  };
  const aaa = Performance.series(state, { range: 'ALL', symbol: 'AAA' });
  const all = Performance.series(state, { range: 'ALL', symbol: 'ALL' });
  assert.strictEqual(aaa.current, 5);
  assert.strictEqual(all.current, -5);
  assert.strictEqual(Performance.normalizeRange('bad'), '3M');
  assert.strictEqual(Performance.normalizeRange('all'), 'ALL');
})();

(function geometryAndMarkers() {
  const state = {
    trades: [{ id: 'b1', symbol: 'AAA', side: 'buy', qty: 1, price: 10, fee: 0, time: '2026-01-01T00:00:00Z' }],
    history: { AAA: rows('2026-01-01', [10, 11, 12]) }, quotes: {}, splits: {},
  };
  const result = Performance.series(state, { range: 'ALL', symbol: 'ALL' });
  const geometry = Performance.geometry(result.points, 'balance', 600, 240, { left: 50, right: 10, top: 10, bottom: 30 });
  const markers = Performance.eventGeometry(result.points, result.events, 'balance', 600, 240, { left: 50, right: 10, top: 10, bottom: 30 });
  assert.ok(geometry.path.startsWith('M '));
  assert.strictEqual(markers.length, 1);
  assert.ok(Number.isFinite(markers[0].x));
})();

console.log('Performance JavaScript tests passed.');
