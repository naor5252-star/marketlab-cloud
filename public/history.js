(function (root) {
  "use strict";
  const RANGE_DAYS = { "1M": 31, "3M": 93, "1Y": 366 };

  function normalizeRange(value) {
    return Object.prototype.hasOwnProperty.call(RANGE_DAYS, value) ? value : "3M";
  }

  function asUtcDate(value) {
    const date = new Date(String(value || "") + "T00:00:00Z");
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function priceValue(row) {
    const adjusted = Number(row && row.adjustedClose);
    return Number.isFinite(adjusted) ? adjusted : Number(row && row.close);
  }

  function filterRows(rows, requestedRange) {
    const range = normalizeRange(requestedRange);
    const clean = Array.isArray(rows)
      ? rows.filter((row) => row && asUtcDate(row.date) && Number.isFinite(priceValue(row)))
          .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
      : [];
    if (clean.length < 2) return clean;
    const latest = asUtcDate(clean[clean.length - 1].date);
    const cutoff = new Date(latest.getTime() - RANGE_DAYS[range] * 86400000);
    const filtered = clean.filter((row) => asUtcDate(row.date) >= cutoff);
    return filtered.length >= 2 ? filtered : clean.slice(-2);
  }

  function splitEvents(rows, splits, requestedRange) {
    const selected = filterRows(rows, requestedRange);
    if (selected.length < 2 || !Array.isArray(splits)) return [];
    const first = String(selected[0].date);
    const last = String(selected[selected.length - 1].date);
    return splits.filter((event) => {
      const effective = String(event && (event.effectiveDate || event.date) || "");
      const factor = Number(event && event.factor);
      return effective >= first && effective <= last && Number.isFinite(factor) && factor > 0 && Math.abs(factor - 1) > 1e-12;
    }).map((event) => ({ effectiveDate: String(event.effectiveDate || event.date), factor: Number(event.factor) }))
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  }

  function stats(rows, requestedRange, splits) {
    const range = normalizeRange(requestedRange);
    const filtered = filterRows(rows, range);
    if (filtered.length < 2) {
      return { range, rows: filtered, complete: false, availableDays: 0, change: 0, changePercent: 0, splits: [] };
    }
    const start = priceValue(filtered[0]);
    const end = priceValue(filtered[filtered.length - 1]);
    const values = filtered.map(priceValue);
    const high = Math.max(...values);
    const low = Math.min(...values);
    const allClean = Array.isArray(rows) ? rows.filter((row) => row && asUtcDate(row.date)).slice().sort((a,b)=>String(a.date).localeCompare(String(b.date))) : [];
    const firstAll = allClean.length ? asUtcDate(allClean[0].date) : null;
    const lastAll = allClean.length ? asUtcDate(allClean[allClean.length - 1].date) : null;
    const availableDays = firstAll && lastAll ? Math.max(0, Math.round((lastAll - firstAll) / 86400000)) : 0;
    return {
      range,
      rows: filtered,
      start,
      end,
      high,
      low,
      change: end - start,
      changePercent: start ? ((end / start) - 1) * 100 : 0,
      availableDays,
      complete: availableDays >= RANGE_DAYS[range] - 7,
      requestedDays: RANGE_DAYS[range],
      splits: splitEvents(rows, splits, range),
      adjusted: filtered.some((row) => Number.isFinite(Number(row.adjustedClose)) && Math.abs(Number(row.adjustedClose) - Number(row.close)) > 1e-9),
    };
  }

  function geometry(rows, width, height, padding) {
    const values = rows.map(priceValue);
    if (values.length < 2) return { points: [], path: "", min: 0, max: 0 };
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const rawRange = maxValue - minValue || Math.max(1, maxValue * 0.02);
    const min = minValue - rawRange * 0.08;
    const max = maxValue + rawRange * 0.08;
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const points = values.map((value, index) => ({
      x: padding.left + (index / (values.length - 1)) * innerWidth,
      y: padding.top + (1 - (value - min) / (max - min)) * innerHeight,
      value,
      rawValue: Number(rows[index].close),
      adjusted: Number.isFinite(Number(rows[index].adjustedClose)),
      date: rows[index].date,
    }));
    return {
      points,
      path: points.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" "),
      min,
      max,
    };
  }

  function markerGeometry(rows, splits, width, padding) {
    const events = splitEvents(rows, splits, "1Y");
    if (!rows.length) return [];
    const first = String(rows[0].date), last = String(rows[rows.length - 1].date);
    return events.filter((event) => event.effectiveDate >= first && event.effectiveDate <= last).map((event) => {
      let index = rows.findIndex((row) => String(row.date) >= event.effectiveDate);
      if (index < 0) index = rows.length - 1;
      return {
        ...event,
        index,
        x: padding.left + (index / Math.max(1, rows.length - 1)) * (width - padding.left - padding.right),
      };
    });
  }

  function splitRatioLabel(factor) {
    const value = Number(factor);
    if (!Number.isFinite(value) || value <= 0) return "Split";
    if (value >= 1) return `${Number(value.toFixed(4))}:1 split`;
    return `1:${Number((1 / value).toFixed(4))} reverse split`;
  }

  const api = { RANGE_DAYS, normalizeRange, asUtcDate, priceValue, filterRows, splitEvents, stats, geometry, markerGeometry, splitRatioLabel };
  root.MarketLabHistory = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
