(function (root) {
  "use strict";

  const RANGE_DAYS = { "1M": 31, "3M": 93, "1Y": 366, "ALL": Infinity };

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : (fallback || 0);
  }

  function normalizeRange(value) {
    const key = String(value || "").toUpperCase();
    return Object.prototype.hasOwnProperty.call(RANGE_DAYS, key) ? key : "3M";
  }

  function dateOnly(value) {
    const text = String(value || "");
    const match = text.match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : "";
  }

  function asDate(value) {
    const day = dateOnly(value);
    if (!day) return null;
    const parsed = new Date(day + "T00:00:00Z");
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  function uniqueSorted(values) {
    return Array.from(new Set(values.filter(Boolean))).sort();
  }

  function splitFactorAfter(state, symbol, tradeDate) {
    const events = state && state.splits && Array.isArray(state.splits[symbol]) ? state.splits[symbol] : [];
    return events.reduce((factor, event) => {
      const effectiveDate = dateOnly(event && (event.effectiveDate || event.date));
      const value = number(event && event.factor, 1);
      return effectiveDate && effectiveDate > tradeDate && value > 0 ? factor * value : factor;
    }, 1);
  }

  function adjustedTrade(trade, state) {
    const symbol = String(trade && trade.symbol || "").toUpperCase();
    const day = dateOnly(trade && trade.time);
    const factor = splitFactorAfter(state, symbol, day);
    return {
      ...trade,
      symbol,
      day,
      originalQty: number(trade && trade.qty, 0),
      originalPrice: number(trade && trade.price, 0),
      adjustedQty: number(trade && trade.qty, 0) * factor,
      adjustedPrice: factor > 0 ? number(trade && trade.price, 0) / factor : number(trade && trade.price, 0),
      fee: Math.max(0, number(trade && trade.fee, 0)),
      factor,
    };
  }

  function rowPrice(row) {
    const adjusted = Number(row && row.adjustedClose);
    if (Number.isFinite(adjusted) && adjusted > 0) return adjusted;
    const close = Number(row && row.close);
    return Number.isFinite(close) && close > 0 ? close : NaN;
  }

  function selectedSymbols(state, symbolFilter) {
    const filter = String(symbolFilter || "ALL").toUpperCase();
    if (filter !== "ALL") return [filter];
    const values = [];
    for (const trade of state.trades || []) values.push(String(trade.symbol || "").toUpperCase());
    for (const symbol of Object.keys(state.history || {})) values.push(symbol.toUpperCase());
    return uniqueSorted(values);
  }

  function series(state, options) {
    const range = normalizeRange(options && options.range);
    const symbolFilter = String(options && options.symbol || "ALL").toUpperCase();
    const symbols = selectedSymbols(state || {}, symbolFilter);
    const allowed = new Set(symbols);
    const trades = (Array.isArray(state && state.trades) ? state.trades : [])
      .map((trade) => adjustedTrade(trade, state || {}))
      .filter((trade) => trade.day && trade.symbol && trade.originalQty > 0 && trade.originalPrice > 0 && allowed.has(trade.symbol))
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));

    if (!trades.length) {
      return { range, symbol: symbolFilter, points: [], events: [], symbols, start: 0, current: 0, change: 0, changePercent: null };
    }

    const firstTradeDay = trades[0].day;
    const dates = trades.map((trade) => trade.day);
    const histories = {};
    for (const symbol of symbols) {
      const rows = Array.isArray(state.history && state.history[symbol]) ? state.history[symbol] : [];
      histories[symbol] = rows
        .filter((row) => dateOnly(row && row.date) && Number.isFinite(rowPrice(row)))
        .map((row) => ({ day: dateOnly(row.date), price: rowPrice(row) }))
        .sort((a, b) => a.day.localeCompare(b.day));
      for (const row of histories[symbol]) if (row.day >= firstTradeDay) dates.push(row.day);
    }

    const quoteDay = dateOnly(new Date().toISOString());
    for (const symbol of symbols) {
      const quote = state.quotes && state.quotes[symbol];
      if (quote && number(quote.price, 0) > 0) dates.push(dateOnly(quote.marketDataAt) || quoteDay);
    }

    const allDates = uniqueSorted(dates).filter((day) => day >= firstTradeDay);
    const latestDay = allDates[allDates.length - 1] || firstTradeDay;
    let cutoff = firstTradeDay;
    if (Number.isFinite(RANGE_DAYS[range])) {
      const latest = asDate(latestDay);
      cutoff = new Date(latest.getTime() - RANGE_DAYS[range] * 86400000).toISOString().slice(0, 10);
    }

    const historyIndexes = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
    const lastPrices = {};
    const positions = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
    const fallbackPrices = {};
    let cash = 0;
    let tradeIndex = 0;
    const points = [];
    const rawEvents = [];

    for (const day of allDates) {
      for (const symbol of symbols) {
        const rows = histories[symbol] || [];
        let index = historyIndexes[symbol] || 0;
        while (index < rows.length && rows[index].day <= day) {
          lastPrices[symbol] = rows[index].price;
          index += 1;
        }
        historyIndexes[symbol] = index;
      }

      while (tradeIndex < trades.length && trades[tradeIndex].day <= day) {
        const trade = trades[tradeIndex];
        const direction = trade.side === "sell" ? -1 : 1;
        positions[trade.symbol] = number(positions[trade.symbol], 0) + direction * trade.adjustedQty;
        fallbackPrices[trade.symbol] = trade.adjustedPrice;
        const cashImpact = trade.side === "buy"
          ? -(trade.originalPrice * trade.originalQty + trade.fee)
          : trade.originalPrice * trade.originalQty - trade.fee;
        cash += cashImpact;
        rawEvents.push({
          id: String(trade.id || `${trade.time}-${trade.symbol}-${trade.side}`),
          day: trade.day,
          time: trade.time,
          symbol: trade.symbol,
          side: trade.side === "sell" ? "sell" : "buy",
          qty: trade.originalQty,
          adjustedQty: trade.adjustedQty,
          price: trade.originalPrice,
          fee: trade.fee,
          cashImpact,
        });
        tradeIndex += 1;
      }

      let marketValue = 0;
      let grossExposure = 0;
      for (const symbol of symbols) {
        const quantity = number(positions[symbol], 0);
        if (Math.abs(quantity) < 1e-12) continue;
        const quote = state.quotes && state.quotes[symbol];
        const price = number(lastPrices[symbol], 0) || number(fallbackPrices[symbol], 0) || number(quote && quote.price, 0);
        const value = quantity * price;
        marketValue += value;
        grossExposure += Math.abs(value);
      }
      const balance = cash + marketValue;
      if (day >= cutoff) points.push({ day, balance, cash, marketValue, grossExposure });
    }

    if (!points.length && allDates.length) {
      const last = allDates[allDates.length - 1];
      points.push({ day: last, balance: cash, cash, marketValue: 0, grossExposure: 0 });
    }

    const pointByDay = new Map(points.map((point) => [point.day, point]));
    const events = rawEvents.filter((event) => event.day >= cutoff).map((event) => {
      let point = pointByDay.get(event.day);
      if (!point) point = points.find((candidate) => candidate.day >= event.day) || points[points.length - 1];
      return { ...event, balanceAfter: point ? point.balance : 0 };
    });
    const start = points.length ? points[0].balance : 0;
    const current = points.length ? points[points.length - 1].balance : 0;
    const change = current - start;
    const changePercent = Math.abs(start) > 1e-9 ? (change / Math.abs(start)) * 100 : null;
    return { range, symbol: symbolFilter, points, events, symbols, start, current, change, changePercent };
  }

  function metricValue(point, metric) {
    if (metric === "cash") return number(point && point.cash, 0);
    if (metric === "exposure") return number(point && point.grossExposure, 0);
    return number(point && point.balance, 0);
  }

  function geometry(points, metric, width, height, padding) {
    if (!Array.isArray(points) || points.length < 1) return { points: [], path: "", min: 0, max: 0 };
    const values = points.map((point) => metricValue(point, metric));
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const span = maxValue - minValue || Math.max(1, Math.abs(maxValue) * 0.04);
    const min = minValue - span * 0.1;
    const max = maxValue + span * 0.1;
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const mapped = points.map((point, index) => ({
      ...point,
      value: values[index],
      x: padding.left + (points.length === 1 ? innerWidth / 2 : index / (points.length - 1) * innerWidth),
      y: padding.top + (1 - (values[index] - min) / (max - min)) * innerHeight,
    }));
    return {
      points: mapped,
      path: mapped.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" "),
      min,
      max,
    };
  }

  function eventGeometry(points, events, metric, width, height, padding) {
    const chart = geometry(points, metric, width, height, padding);
    if (!chart.points.length) return [];
    return (events || []).map((event, eventIndex) => {
      let pointIndex = chart.points.findIndex((point) => point.day >= event.day);
      if (pointIndex < 0) pointIndex = chart.points.length - 1;
      const point = chart.points[pointIndex];
      return { ...event, eventIndex, pointIndex, x: point.x, y: point.y, value: point.value };
    });
  }

  const api = { RANGE_DAYS, normalizeRange, dateOnly, adjustedTrade, series, metricValue, geometry, eventGeometry };
  root.MarketLabPerformance = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
