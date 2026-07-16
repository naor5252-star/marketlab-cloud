const assert = require('assert');
const Trading = require('./support/trading.cjs');
const Insights = require('./support/insights.cjs');

function rows(start, values) {
  const first = new Date(start + 'T00:00:00Z');
  return values.map((price, index) => ({
    date: new Date(first.getTime() + index * 86400000).toISOString().slice(0, 10),
    close: price,
    adjustedClose: price,
  }));
}

{
  const state = {
    positions: [{ symbol: 'KLAC', qty: 2, avg: 100, realized: 0 }],
    quotes: { KLAC: { price: 120 }, SPY: { price: 110 }, QQQ: { price: 115 } },
    history: {
      KLAC: rows('2026-01-01', [100, 110, 120]),
      SPY: rows('2026-01-01', [100, 105, 110]),
      QQQ: rows('2026-01-01', [100, 108, 115]),
    },
    trades: [], cash: -200,
  };
  const simulation = Insights.whatIf(state, { symbol: 'KLAC', side: 'buy', quantity: 1 });
  assert.strictEqual(simulation.valid, true);
  assert.strictEqual(simulation.newQty, 3);
  assert.strictEqual(simulation.scenarios.find(x => x.movePercent === 10).pnl, 12);

  const benchmark = Insights.benchmarkForTrade({
    id: 'x', symbol: 'KLAC', side: 'buy', resultPercent: 20,
    benchmarkStartTime: '2026-01-01', benchmarkEndTime: '2026-01-03',
  }, state);
  assert.strictEqual(benchmark.available, true);
  assert.ok(Math.abs(benchmark.benchmarks.SPY.relativePercent - 10) < 1e-9);

  global.MarketLabTrading = Trading;
  const xray = Insights.xray(state);
  assert.strictEqual(xray.positions.length, 1);
  assert.strictEqual(xray.diversificationScore, 0);
}

{
  const state = {
    positions: [
      { symbol: 'AAA', qty: 1, avg: 10, realized: 0 },
      { symbol: 'BBB', qty: 1, avg: 10, realized: 0 },
    ],
    quotes: { AAA: { price: 10 }, BBB: { price: 10 } },
    history: {
      AAA: rows('2026-01-01', [10,11,12,13,14,15,16,17,18,19,20,21]),
      BBB: rows('2026-01-01', [10,10.5,11,11.5,12,12.5,13,13.5,14,14.5,15,15.5]),
    },
    trades: [], cash: 0,
  };
  global.MarketLabTrading = Trading;
  const xray = Insights.xray(state);
  assert.strictEqual(xray.diversificationScore, 100);
  assert.ok(xray.correlations.length >= 1);
}

console.log('Insights JavaScript tests passed.');
