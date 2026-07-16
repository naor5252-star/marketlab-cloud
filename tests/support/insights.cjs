(function (root) {
  "use strict";

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number(fallback || 0);
  }

  function isoDay(value) {
    const text = String(value || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
  }

  function priceValue(row) {
    return number(row && (row.adjustedClose ?? row.close), NaN);
  }

  function validHistory(state, symbol) {
    return (state && state.history && Array.isArray(state.history[symbol]) ? state.history[symbol] : [])
      .map((row) => ({ day: isoDay(row.date), price: priceValue(row) }))
      .filter((row) => row.day && Number.isFinite(row.price) && row.price > 0)
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  function rangeReturn(state, symbol, startTime, endTime) {
    const rows = validHistory(state, symbol);
    if (rows.length < 2) return null;
    const startDay = isoDay(startTime) || rows[0].day;
    const endDay = isoDay(endTime) || rows[rows.length - 1].day;
    const start = rows.find((row) => row.day >= startDay) || rows[0];
    const end = [...rows].reverse().find((row) => row.day <= endDay) || rows[rows.length - 1];
    if (!start || !end || end.day < start.day || !(start.price > 0)) return null;
    return {
      symbol,
      startDay: start.day,
      endDay: end.day,
      startPrice: start.price,
      endPrice: end.price,
      returnPercent: ((end.price / start.price) - 1) * 100,
    };
  }

  function benchmarkForTrade(result, state) {
    if (!result) return { available: false, reason: "Trade result unavailable" };
    const startTime = result.benchmarkStartTime || result.time;
    const endTime = result.benchmarkEndTime || ((state.quotes && state.quotes[result.symbol] && state.quotes[result.symbol].marketDataAt) || new Date().toISOString());
    const direction = result.side === "sell" && !(result.closedQuantity > 0) ? -1 : 1;
    const tradeReturn = number(result.resultPercent, 0);
    const benchmarks = {};
    for (const symbol of ["SPY", "QQQ"]) {
      const raw = rangeReturn(state, symbol, startTime, endTime);
      if (raw) {
        const directional = raw.returnPercent * direction;
        benchmarks[symbol] = {
          ...raw,
          directionalReturnPercent: directional,
          relativePercent: tradeReturn - directional,
        };
      }
    }
    const available = Object.keys(benchmarks).length > 0;
    return {
      available,
      tradeReturnPercent: tradeReturn,
      startTime,
      endTime,
      benchmarks,
      reason: available ? "" : "Load SPY and QQQ history to compare this trade.",
    };
  }

  function whatIf(state, input) {
    const symbol = String(input && input.symbol || "").toUpperCase();
    const side = input && input.side === "sell" ? "sell" : "buy";
    const quantity = Math.max(0, number(input && input.quantity, 0));
    const quote = state && state.quotes && state.quotes[symbol];
    const price = Math.max(0, number(input && input.price, quote && quote.price));
    if (!symbol || !(quantity > 0) || !(price > 0)) {
      return { valid: false, reason: "Load a quote and enter a positive quantity." };
    }
    const positions = Array.isArray(state.positions) ? state.positions : [];
    const current = positions.find((position) => String(position.symbol).toUpperCase() === symbol);
    const oldQty = number(current && current.qty, 0);
    const delta = side === "buy" ? quantity : -quantity;
    const newQty = oldQty + delta;
    const currentMetrics = root.MarketLabTrading ? root.MarketLabTrading.metrics(state) : { grossExposure: 0 };
    const oldExposure = Math.abs(oldQty * price);
    const newExposure = Math.abs(newQty * price);
    const projectedGross = Math.max(0, number(currentMetrics.grossExposure, 0) - oldExposure + newExposure);
    const concentration = projectedGross > 0 ? newExposure / projectedGross * 100 : 0;
    const scenarios = [-20, -10, -5, 5, 10, 20].map((movePercent) => {
      const futurePrice = price * (1 + movePercent / 100);
      const pnl = delta * (futurePrice - price);
      return { movePercent, futurePrice, pnl, returnPercent: movePercent * Math.sign(delta || 1) };
    });
    const warnings = [];
    if (concentration > 50) warnings.push(`${symbol} would represent ${concentration.toFixed(1)}% of gross exposure.`);
    else if (concentration > 30) warnings.push(`${symbol} concentration would be elevated at ${concentration.toFixed(1)}%.`);
    if (Math.sign(oldQty) && Math.sign(newQty) !== Math.sign(oldQty) && Math.abs(newQty) > 1e-10) warnings.push("This order crosses through flat and reverses the position direction.");
    if (Math.abs(newQty) < 1e-10) warnings.push("This order would fully close the current position.");
    return {
      valid: true,
      symbol,
      side,
      quantity,
      price,
      notional: quantity * price,
      oldQty,
      newQty,
      projectedGross,
      concentration,
      scenarios,
      warnings,
    };
  }

  function returnsByDay(state, symbol) {
    const rows = validHistory(state, symbol);
    const result = {};
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1].price;
      const current = rows[index].price;
      if (previous > 0) result[rows[index].day] = current / previous - 1;
    }
    return result;
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function sampleVariance(values) {
    if (values.length < 2) return 0;
    const avg = mean(values);
    return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  }

  function covariance(a, b) {
    if (a.length !== b.length || a.length < 2) return 0;
    const ma = mean(a), mb = mean(b);
    return a.reduce((sum, value, index) => sum + (value - ma) * (b[index] - mb), 0) / (a.length - 1);
  }

  function correlationFor(state, first, second) {
    const a = returnsByDay(state, first), b = returnsByDay(state, second);
    const days = Object.keys(a).filter((day) => Object.prototype.hasOwnProperty.call(b, day));
    if (days.length < 10) return null;
    const av = days.map((day) => a[day]), bv = days.map((day) => b[day]);
    const denom = Math.sqrt(sampleVariance(av) * sampleVariance(bv));
    if (!(denom > 0)) return null;
    return { first, second, correlation: covariance(av, bv) / denom, observations: days.length };
  }

  function xray(state) {
    const positions = Array.isArray(state && state.positions) ? state.positions : [];
    const metrics = root.MarketLabTrading ? root.MarketLabTrading.metrics(state) : { grossExposure: 0, longExposure: 0, shortExposure: 0 };
    const exposures = positions.map((position) => {
      const quote = state.quotes && state.quotes[position.symbol];
      const price = number(quote && quote.price, position.avg);
      const signedValue = number(position.qty, 0) * price;
      return {
        symbol: position.symbol,
        qty: number(position.qty, 0),
        price,
        signedValue,
        exposure: Math.abs(signedValue),
      };
    }).filter((position) => position.exposure > 0).sort((a, b) => b.exposure - a.exposure);
    const gross = exposures.reduce((sum, position) => sum + position.exposure, 0);
    for (const position of exposures) position.weightPercent = gross > 0 ? position.exposure / gross * 100 : 0;
    const hhi = exposures.reduce((sum, position) => sum + (position.weightPercent / 100) ** 2, 0);
    const n = exposures.length;
    const normalizedHhi = n > 1 ? Math.max(0, Math.min(1, (hhi - 1 / n) / (1 - 1 / n))) : 1;
    const diversificationScore = Math.round((1 - normalizedHhi) * 100);
    const correlations = [];
    for (let i = 0; i < exposures.length; i += 1) {
      for (let j = i + 1; j < exposures.length; j += 1) {
        const value = correlationFor(state, exposures[i].symbol, exposures[j].symbol);
        if (value) correlations.push(value);
      }
    }
    correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    const dailyMaps = Object.fromEntries(exposures.map((position) => [position.symbol, returnsByDay(state, position.symbol)]));
    const commonDays = exposures.length ? Object.keys(dailyMaps[exposures[0].symbol] || {}).filter((day) => exposures.every((position) => Object.prototype.hasOwnProperty.call(dailyMaps[position.symbol] || {}, day))) : [];
    const portfolioReturns = commonDays.map((day) => exposures.reduce((sum, position) => sum + (position.signedValue / Math.max(gross, 1)) * dailyMaps[position.symbol][day], 0));
    const annualizedVolatility = portfolioReturns.length >= 10 ? Math.sqrt(sampleVariance(portfolioReturns)) * Math.sqrt(252) * 100 : null;

    const spy = returnsByDay(state, "SPY");
    const betaDays = commonDays.filter((day) => Object.prototype.hasOwnProperty.call(spy, day));
    const betaPortfolio = betaDays.map((day) => exposures.reduce((sum, position) => sum + (position.signedValue / Math.max(gross, 1)) * dailyMaps[position.symbol][day], 0));
    const betaSpy = betaDays.map((day) => spy[day]);
    const spyVariance = sampleVariance(betaSpy);
    const beta = betaDays.length >= 10 && spyVariance > 0 ? covariance(betaPortfolio, betaSpy) / spyVariance : null;

    const flags = [];
    if (exposures[0] && exposures[0].weightPercent > 50) flags.push(`${exposures[0].symbol} is more than half of gross exposure.`);
    else if (exposures[0] && exposures[0].weightPercent > 30) flags.push(`${exposures[0].symbol} is a concentrated position at ${exposures[0].weightPercent.toFixed(1)}%.`);
    if (metrics.shortExposure > metrics.longExposure && metrics.shortExposure > 0) flags.push("Short exposure is larger than long exposure.");
    if (correlations[0] && correlations[0].correlation > 0.8) flags.push(`${correlations[0].first} and ${correlations[0].second} have high historical correlation (${correlations[0].correlation.toFixed(2)}).`);
    if (!flags.length && exposures.length) flags.push("No single rule-based concentration warning was triggered with the currently loaded data.");

    return {
      positions: exposures,
      grossExposure: gross,
      netExposure: exposures.reduce((sum, position) => sum + position.signedValue, 0),
      diversificationScore,
      concentrationHhi: hhi,
      annualizedVolatility,
      beta,
      correlations,
      observations: commonDays.length,
      flags,
    };
  }

  const api = { benchmarkForTrade, correlationFor, rangeReturn, whatIf, xray };
  root.MarketLabInsights = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
