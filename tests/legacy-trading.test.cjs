const assert = require('assert');
const trading = require('./support/trading.cjs');

function base() {
  return { version: 7, cash: 0, positions: [], trades: [], watchlist: [], quotes: {} };
}

{
  const migrated = trading.migrateState(
    { version: 3, cash: 800, initialCapital: 1000, positions: [{ symbol: 'aapl', qty: 2, avg: 100 }] },
    { version: 7, cash: 0, positions: [], trades: [], watchlist: ['KLAC'], quotes: {}, history: {}, splits: {}, splitStatus: {}, boardQty: '1' },
  );
  assert.strictEqual(migrated.cash, -200);
  assert.strictEqual(migrated.version, 7);
  assert.deepStrictEqual(migrated.watchlist, ['KLAC', 'AAPL']);
  assert.ok(!Object.prototype.hasOwnProperty.call(migrated, 'initialCapital'));
}

{
  const bought = trading.applyTrade(base(), { id: 'b1', symbol: 'KLAC', side: 'buy', quantity: 2, price: 100, fee: 1, provider: 'test' });
  assert.strictEqual(bought.cash, -201);
  assert.strictEqual(bought.positions[0].qty, 2);
  assert.strictEqual(bought.positions[0].avg, 100);
}

{
  const shorted = trading.applyTrade(base(), { id: 's1', symbol: 'KLAC', side: 'sell', quantity: 3, price: 100, fee: 0, provider: 'test' });
  assert.strictEqual(shorted.cash, 300);
  assert.strictEqual(shorted.positions[0].qty, -3);
  assert.strictEqual(shorted.positions[0].avg, 100);
}

{
  let state = trading.applyTrade(base(), { id: 'b1', symbol: 'AAPL', side: 'buy', quantity: 2, price: 100, fee: 0 });
  state = trading.applyTrade(state, { id: 's1', symbol: 'AAPL', side: 'sell', quantity: 3, price: 110, fee: 0 });
  const position = state.positions[0];
  assert.strictEqual(position.qty, -1);
  assert.strictEqual(position.avg, 110);
  assert.strictEqual(position.realized, 20);
  state.quotes.AAPL = { price: 105 };
  const metrics = trading.metrics(state);
  assert.strictEqual(metrics.netResult, 25);
  assert.strictEqual(metrics.unrealized, 5);
  assert.strictEqual(metrics.realized, 20);
  assert.strictEqual(metrics.shortExposure, 105);
}

{
  let state = trading.applyTrade(base(), { id: 's1', symbol: 'MSFT', side: 'sell', quantity: 4, price: 200, fee: 0 });
  state = trading.applyTrade(state, { id: 'b1', symbol: 'MSFT', side: 'buy', quantity: 1.5, price: 180, fee: 0 });
  assert.strictEqual(state.positions[0].qty, -2.5);
  assert.strictEqual(state.positions[0].avg, 200);
  assert.strictEqual(state.positions[0].realized, 30);
}

assert.deepStrictEqual(trading.uniqueSymbols(['klac', 'AAPL', 'KLAC', '', 'msft']), ['KLAC', 'AAPL', 'MSFT']);
console.log('trading.js tests passed');


{
  let state = trading.applyTrade(base(), { id: 'open-long', symbol: 'AAPL', side: 'buy', quantity: 2, price: 100, fee: 0, time: '2026-01-01' });
  state.quotes.AAPL = { price: 120 };
  const result = trading.tradeResults(state)[0];
  assert.strictEqual(result.resultValue, 40);
  assert.strictEqual(result.resultPercent, 20);
  assert.strictEqual(result.status, 'unrealized');
}

{
  let state = trading.applyTrade(base(), { id: 'open-short', symbol: 'KLAC', side: 'sell', quantity: 3, price: 100, fee: 0, time: '2026-01-01' });
  state.quotes.KLAC = { price: 80 };
  const result = trading.tradeResults(state)[0];
  assert.strictEqual(result.resultValue, 60);
  assert.strictEqual(result.resultPercent, 20);
  assert.strictEqual(result.statusLabel, 'Unrealized');
}

{
  let state = trading.applyTrade(base(), { id: 'entry', symbol: 'MSFT', side: 'buy', quantity: 2, price: 100, fee: 1, time: '2026-01-01' });
  state = trading.applyTrade(state, { id: 'close', symbol: 'MSFT', side: 'sell', quantity: 1, price: 120, fee: 1, time: '2026-01-02' });
  state.quotes.MSFT = { price: 110 };
  const results = Object.fromEntries(trading.tradeResults(state).map(item => [item.id, item]));
  assert.strictEqual(results.close.realizedValue, 20);
  assert.strictEqual(results.close.resultValue, 19);
  assert.strictEqual(results.close.resultPercent, 19);
  assert.strictEqual(results.close.status, 'realized');
  assert.strictEqual(results.entry.unrealizedValue, 10);
  assert.strictEqual(results.entry.resultValue, 9);
  assert.strictEqual(results.entry.resultPercent, 9);
}

{
  let state = trading.applyTrade(base(), { id: 'long', symbol: 'NVDA', side: 'buy', quantity: 2, price: 100, fee: 0, time: '2026-01-01' });
  state = trading.applyTrade(state, { id: 'cross', symbol: 'NVDA', side: 'sell', quantity: 3, price: 110, fee: 0, time: '2026-01-02' });
  state.quotes.NVDA = { price: 105 };
  const cross = trading.tradeResults(state).find(item => item.id === 'cross');
  assert.strictEqual(cross.realizedValue, 20);
  assert.strictEqual(cross.unrealizedValue, 5);
  assert.strictEqual(cross.resultValue, 25);
  assert.strictEqual(cross.status, 'mixed');
}

{
  const position = { symbol: 'QQQ', qty: -2, avg: 500 };
  const result = trading.positionResult(position, { QQQ: { price: 450 } });
  assert.strictEqual(result.value, 100);
  assert.strictEqual(result.percent, 10);
}
