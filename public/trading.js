(function (root) {
  "use strict";

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : (fallback || 0);
  }

  function uniqueSymbols(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).map((value) => String(value || "").trim().toUpperCase())
      .filter((value) => value && !seen.has(value) && (seen.add(value) || true));
  }

  function migrateState(saved, defaults) {
    const source = saved && typeof saved === "object" ? saved : {};
    const next = { ...defaults, ...source };
    const sourceVersion = number(source.version, 0);
    if (sourceVersion < 5) {
      next.cash = number(source.cash, 0) - number(source.initialCapital, 0);
    } else {
      next.cash = number(source.cash, 0);
    }
    delete next.initialCapital;
    next.version = number(defaults.version, 12) || 12;
    next.positions = (Array.isArray(source.positions) ? source.positions : []).map((position) => ({
      symbol: String(position.symbol || "").toUpperCase(),
      qty: number(position.qty, 0),
      avg: Math.max(0, number(position.avg, 0)),
      realized: number(position.realized, 0),
    })).filter((position) => position.symbol && Math.abs(position.qty) > 1e-10);
    next.trades = Array.isArray(source.trades) ? source.trades : [];
    next.watchlist = uniqueSymbols([
      ...(Array.isArray(defaults.watchlist) ? defaults.watchlist : []),
      ...(Array.isArray(source.watchlist) ? source.watchlist : []),
      ...next.positions.map((position) => position.symbol),
    ]);
    next.boardQty = String(source.boardQty || defaults.boardQty || "1");
    next.quotes = source.quotes && typeof source.quotes === "object" ? source.quotes : {};
    next.history = source.history && typeof source.history === "object" ? source.history : {};
    next.splits = source.splits && typeof source.splits === "object" ? source.splits : {};
    next.splitStatus = source.splitStatus && typeof source.splitStatus === "object" ? source.splitStatus : {};
    next.tradeDraft = source.tradeDraft && typeof source.tradeDraft === "object" ? source.tradeDraft : { thesis: "", expectedHolding: "", targetPrice: "", invalidationPrice: "", confidence: "60", notes: "" };
    next.tradeReviews = source.tradeReviews && typeof source.tradeReviews === "object" ? source.tradeReviews : {};
    next.whatIf = source.whatIf && typeof source.whatIf === "object" ? source.whatIf : { symbol: next.symbol || "KLAC", side: "buy", quantity: "1" };
    next.settings = { ...(defaults.settings || {}), ...(source.settings && typeof source.settings === "object" ? source.settings : {}) };
    next.onboardingDismissed = Boolean(source.onboardingDismissed);
    return next;
  }

  function applyTrade(state, input) {
    const symbol = String(input.symbol || "").trim().toUpperCase();
    const side = input.side === "sell" ? "sell" : "buy";
    const quantity = number(input.quantity, 0);
    const price = number(input.price, 0);
    const fee = Math.max(0, number(input.fee, 0));
    if (!symbol) throw new Error("A symbol is required.");
    if (!(quantity > 0)) throw new Error("Quantity must be positive.");
    if (!(price > 0)) throw new Error("Execution price must be positive.");

    const positions = Array.isArray(state.positions) ? state.positions.map((position) => ({ ...position })) : [];
    let position = positions.find((item) => item.symbol === symbol);
    const oldQty = number(position && position.qty, 0);
    const oldAverage = number(position && position.avg, price);
    const oldRealized = number(position && position.realized, 0);
    const delta = side === "buy" ? quantity : -quantity;
    const newQty = oldQty + delta;
    let newAverage = oldAverage;
    let realized = oldRealized;

    if (Math.abs(oldQty) < 1e-10 || Math.sign(oldQty) === Math.sign(delta)) {
      newAverage = (Math.abs(oldQty) * oldAverage + Math.abs(delta) * price) / Math.abs(newQty);
    } else {
      const closingQuantity = Math.min(Math.abs(oldQty), Math.abs(delta));
      realized += closingQuantity * (oldQty > 0 ? price - oldAverage : oldAverage - price);
      if (Math.abs(newQty) < 1e-10) {
        newAverage = 0;
      } else if (Math.sign(newQty) !== Math.sign(oldQty)) {
        newAverage = price;
      }
    }

    if (!position && Math.abs(newQty) > 1e-10) {
      position = { symbol, qty: newQty, avg: newAverage, realized };
      positions.push(position);
    } else if (position && Math.abs(newQty) > 1e-10) {
      position.qty = newQty;
      position.avg = newAverage;
      position.realized = realized;
    } else if (position) {
      positions.splice(positions.indexOf(position), 1);
    }

    const cashDelta = side === "buy" ? -(price * quantity + fee) : price * quantity - fee;
    const trade = {
      id: input.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      symbol,
      side,
      qty: quantity,
      price,
      fee,
      time: input.time || new Date().toISOString(),
      provider: input.provider || "Unknown",
      positionAfter: newQty,
      realizedAfter: realized,
      journal: input.journal && typeof input.journal === "object" ? { ...input.journal } : null,
    };
    return {
      ...state,
      cash: number(state.cash, 0) + cashDelta,
      positions,
      trades: [trade, ...(Array.isArray(state.trades) ? state.trades : [])],
      watchlist: uniqueSymbols([...(state.watchlist || []), symbol]),
    };
  }

  function quotePrice(quotes, symbol, fallback) {
    const price = number(quotes && quotes[symbol] && quotes[symbol].price, NaN);
    return Number.isFinite(price) && price > 0 ? price : number(fallback, 0);
  }

  function metrics(state) {
    const quotes = state.quotes || {};
    let positionValue = 0;
    let unrealized = 0;
    let realized = 0;
    let grossExposure = 0;
    let longExposure = 0;
    let shortExposure = 0;
    for (const position of state.positions || []) {
      const price = quotePrice(quotes, position.symbol, position.avg);
      const value = number(position.qty, 0) * price;
      const exposure = Math.abs(value);
      positionValue += value;
      unrealized += number(position.qty, 0) * (price - number(position.avg, 0));
      realized += number(position.realized, 0);
      grossExposure += exposure;
      if (value >= 0) longExposure += value;
      else shortExposure += exposure;
    }
    return {
      netResult: number(state.cash, 0) + positionValue,
      netCashFlow: number(state.cash, 0),
      positionValue,
      unrealized,
      realized,
      grossExposure,
      longExposure,
      shortExposure,
      positionCount: (state.positions || []).length,
    };
  }

  function positionResult(position, quotes) {
    if (!position) return { value: 0, percent: 0, currentPrice: 0, basis: 0 };
    const quantity = number(position.qty, 0);
    const average = Math.max(0, number(position.avg, 0));
    const currentPrice = quotePrice(quotes || {}, position.symbol, average);
    const value = quantity * (currentPrice - average);
    const basis = Math.abs(quantity) * average;
    return {
      value,
      percent: basis > 0 ? (value / basis) * 100 : 0,
      currentPrice,
      basis,
    };
  }

  function tradeResults(state) {
    const sourceTrades = Array.isArray(state && state.trades) ? state.trades : [];
    const chronological = sourceTrades.slice().reverse();
    const lotsBySymbol = {};
    const resultById = {};

    for (const trade of chronological) {
      const id = String(trade.id || `${trade.time || ""}-${trade.symbol || ""}-${trade.side || ""}`);
      const symbol = String(trade.symbol || "").toUpperCase();
      const direction = trade.side === "sell" ? -1 : 1;
      const quantity = Math.max(0, number(trade.qty, 0));
      const price = Math.max(0, number(trade.price, 0));
      const fee = Math.max(0, number(trade.fee, 0));
      const result = {
        tradeId: id, symbol, side: trade.side === "sell" ? "sell" : "buy",
        realizedValue: 0, unrealizedValue: 0, resultValue: -fee, resultPercent: 0,
        closedQuantity: 0, openedQuantity: 0, remainingQuantity: 0, basis: 0, fee,
        status: "fee", statusLabel: fee > 0 ? "Fee" : "No position effect",
        benchmarkStartTime: trade.time || null, benchmarkEndTime: null,
      };
      resultById[id] = result;
      if (!(quantity > 0) || !(price > 0) || !symbol) continue;

      let remaining = quantity;
      const lots = lotsBySymbol[symbol] || (lotsBySymbol[symbol] = []);
      for (const lot of lots) {
        if (remaining <= 1e-10) break;
        if (lot.remaining <= 1e-10 || lot.direction === direction) continue;
        const closing = Math.min(remaining, lot.remaining);
        const realized = closing * (lot.direction > 0 ? price - lot.entryPrice : lot.entryPrice - price);
        result.realizedValue += realized;
        result.closedQuantity += closing;
        result.basis += closing * lot.entryPrice;
        result.matchedEntryValue = (result.matchedEntryValue || 0) + closing * lot.entryPrice;
        result.matchedEntryQuantity = (result.matchedEntryQuantity || 0) + closing;
        result.matchedEntryTimes = result.matchedEntryTimes || [];
        if (lot.entryTime) result.matchedEntryTimes.push(lot.entryTime);
        lot.remaining -= closing;
        remaining -= closing;
      }
      lotsBySymbol[symbol] = lots.filter((lot) => lot.remaining > 1e-10);
      if (remaining > 1e-10) {
        lotsBySymbol[symbol].push({ tradeId: id, direction, entryPrice: price, entryTime: trade.time || null, remaining, openedQuantity: remaining });
        result.openedQuantity += remaining;
      }
    }

    for (const [symbol, lots] of Object.entries(lotsBySymbol)) {
      for (const lot of lots) {
        const result = resultById[lot.tradeId];
        if (!result || lot.remaining <= 1e-10) continue;
        const currentPrice = quotePrice(state && state.quotes, symbol, lot.entryPrice);
        const unrealized = lot.remaining * (lot.direction > 0 ? currentPrice - lot.entryPrice : lot.entryPrice - currentPrice);
        result.unrealizedValue += unrealized;
        result.remainingQuantity += lot.remaining;
        result.basis += lot.remaining * lot.entryPrice;
      }
    }

    for (const result of Object.values(resultById)) {
      result.resultValue = result.realizedValue + result.unrealizedValue - result.fee;
      result.resultPercent = result.basis > 0 ? (result.resultValue / result.basis) * 100 : 0;
      result.matchedEntryPrice = result.matchedEntryQuantity > 0 ? result.matchedEntryValue / result.matchedEntryQuantity : null;
      result.currentPrice = quotePrice(state && state.quotes, result.symbol, result.price);
      if (result.closedQuantity > 0) {
        result.benchmarkStartTime = (result.matchedEntryTimes || []).sort()[0] || result.time || null;
        result.benchmarkEndTime = result.time || null;
      } else {
        result.benchmarkStartTime = result.time || null;
        result.benchmarkEndTime = (state && state.quotes && state.quotes[result.symbol] && state.quotes[result.symbol].marketDataAt) || null;
      }
      if (result.closedQuantity > 0 && result.remainingQuantity > 0) {
        result.status = "mixed"; result.statusLabel = "Realized + unrealized";
      } else if (result.closedQuantity > 0) {
        result.status = "realized"; result.statusLabel = "Realized";
      } else if (result.remainingQuantity > 0 && result.remainingQuantity + 1e-10 < result.openedQuantity) {
        result.status = "partial"; result.statusLabel = "Partially open";
      } else if (result.remainingQuantity > 0) {
        result.status = "unrealized"; result.statusLabel = "Unrealized";
      } else if (result.openedQuantity > 0) {
        result.status = "closed"; result.statusLabel = "Closed by a later trade";
      }
    }

    return sourceTrades.map((trade) => {
      const id = String(trade.id || `${trade.time || ""}-${trade.symbol || ""}-${trade.side || ""}`);
      return { ...trade, ...(resultById[id] || { resultValue: -Math.max(0, number(trade.fee, 0)), resultPercent: 0, status: "fee", statusLabel: "Fee" }) };
    });
  }

  const api = { applyTrade, metrics, migrateState, positionResult, tradeResults, uniqueSymbols };
  root.MarketLabTrading = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
