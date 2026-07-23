import assert from "node:assert/strict";
import test from "node:test";
import {
  createPasswordRecord,
  derivePasswordHash,
  normalizeUsername,
  rebuildLedgerState,
  validateTrade,
} from "../src/worker-v22.js";

test("normalizes valid usernames and rejects unsafe names", () => {
  assert.equal(normalizeUsername(" Naor.User "), "naor.user");
  assert.throws(() => normalizeUsername("ab"), /3–32/);
  assert.throws(() => normalizeUsername("bad user"), /3–32/);
});

test("PBKDF2 password records can be reproduced", async () => {
  const record = await createPasswordRecord("a-secure-password");
  assert.ok(record.salt.length > 10);
  assert.ok(record.hash.length > 20);
  assert.equal(
    await derivePasswordHash("a-secure-password", record.salt, record.iterations),
    record.hash,
  );
  assert.notEqual(
    await derivePasswordHash("wrong-password", record.salt, record.iterations),
    record.hash,
  );
});

test("rebuilds cash and positions after edited historical trades", () => {
  const trades = [
    { id: "2", symbol: "AAPL", side: "sell", qty: 1, price: 120, fee: 1, time: "2026-02-01T10:00:00.000Z" },
    { id: "1", symbol: "AAPL", side: "buy", qty: 2, price: 100, fee: 1, time: "2026-01-01T10:00:00.000Z" },
  ];
  const result = rebuildLedgerState({ watchlist: [] }, trades);
  assert.equal(result.cash, -82);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].symbol, "AAPL");
  assert.equal(result.positions[0].qty, 1);
  assert.equal(result.positions[0].avg, 100);
  assert.equal(result.positions[0].realized, 20);
  assert.equal(result.trades[0].id, "2");
  assert.equal(result.trades[0].positionAfter, 1);
});

test("validates trade edits and preserves journal fields", () => {
  const trade = validateTrade({
    id: "t-1",
    symbol: " aapl ",
    side: "sell",
    quantity: "2.5",
    price: "201.25",
    fee: "1",
    time: "2026-07-01T08:30:00Z",
    journal: { thesis: "Test thesis", notes: "Evidence" },
  });
  assert.equal(trade.symbol, "AAPL");
  assert.equal(trade.qty, 2.5);
  assert.equal(trade.price, 201.25);
  assert.equal(trade.side, "sell");
  assert.equal(trade.journal.notes, "Evidence");
  assert.throws(() => validateTrade({ symbol: "AAPL", qty: 0, price: 10 }), /positive/);
});
