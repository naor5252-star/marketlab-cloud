import test from "node:test";
import assert from "node:assert/strict";
import { applySplitAdjustments, normalizeSymbol, parseSplitEvents, parseTwelveQuote, safeEqual } from "../src/worker.js";

test("normalizes valid stock symbols", () => {
  assert.equal(normalizeSymbol(" klac "), "KLAC");
  assert.equal(normalizeSymbol("brk.b"), "BRK.B");
  assert.throws(() => normalizeSymbol(""), /Invalid symbol/);
});

test("parses a Twelve Data quote", () => {
  const quote = parseTwelveQuote({ symbol: "KLAC", name: "KLA Corporation", close: "231.52", previous_close: "229.52", change: "2", percent_change: "0.8714", currency: "USD", timestamp: 1783710000 });
  assert.equal(quote.symbol, "KLAC");
  assert.equal(quote.price, 231.52);
  assert.equal(quote.provider, "Twelve Data /quote");
  assert.equal(quote.dataMode, "provider");
});

test("normalizes split events and adjusts old prices", () => {
  const splits = parseSplitEvents({ data: [{ effective_date: "2026-06-12", split_factor: "10" }] });
  assert.deepEqual(splits, [{ effectiveDate: "2026-06-12", factor: 10 }]);
  const rows = applySplitAdjustments([
    { date: "2026-06-11", open: 2200, high: 2400, low: 2100, close: 2300, volume: 100 },
    { date: "2026-06-12", open: 230, high: 250, low: 220, close: 240, volume: 1000 },
  ], splits);
  assert.equal(rows[0].adjustedClose, 230);
  assert.equal(rows[0].splitAdjustmentFactor, 10);
  assert.equal(rows[1].adjustedClose, 240);
  assert.equal(rows[1].splitAdjustmentFactor, 1);
});

test("constant-time comparison accepts equal values", async () => {
  assert.equal(await safeEqual("correct", "correct"), true);
  assert.equal(await safeEqual("correct", "wrong"), false);
});
