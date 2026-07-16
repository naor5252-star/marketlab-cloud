const assert = require('assert');
const history = require('./support/history.cjs');
const start = new Date('2025-01-01T00:00:00Z');
const rows = Array.from({length: 400}, (_, i) => ({
  date: new Date(start.getTime() + i * 86400000).toISOString().slice(0,10),
  close: 100 + i * 0.5,
  adjustedClose: 100 + i * 0.5,
}));
assert(history.filterRows(rows, '1M').length >= 31 && history.filterRows(rows, '1M').length <= 32);
assert(history.filterRows(rows, '3M').length >= 93 && history.filterRows(rows, '3M').length <= 94);
assert(history.filterRows(rows, '1Y').length >= 366 && history.filterRows(rows, '1Y').length <= 367);
const stats = history.stats(rows, '1Y', []);
assert(stats.complete);
assert(stats.change > 0);
assert(stats.high > stats.low);
const geometry = history.geometry(history.filterRows(rows, '1M'), 640, 238, {left:52,right:12,top:15,bottom:31});
assert(geometry.points.length > 2);
assert(geometry.path.startsWith('M '));

const splitRows = [
  {date:'2025-06-09',close:100,adjustedClose:50},
  {date:'2025-06-10',close:51,adjustedClose:51},
  {date:'2025-06-11',close:52,adjustedClose:52},
];
const split = [{effectiveDate:'2025-06-10',factor:2}];
const splitStats = history.stats(splitRows, '1M', split);
assert.strictEqual(splitStats.start, 50);
assert.strictEqual(splitStats.end, 52);
assert(Math.abs(splitStats.changePercent - 4) < 0.00001);
assert.strictEqual(splitStats.splits.length, 1);
assert.strictEqual(history.splitRatioLabel(2), '2:1 split');
assert.strictEqual(history.splitRatioLabel(0.1), '1:10 reverse split');
const splitGeometry = history.geometry(splitRows, 640, 238, {left:52,right:12,top:15,bottom:31});
assert.strictEqual(splitGeometry.points[0].value, 50);
assert.strictEqual(splitGeometry.points[0].rawValue, 100);
console.log('History and split frontend tests passed');
