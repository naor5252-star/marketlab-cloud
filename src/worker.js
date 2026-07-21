const APP_NAME = "MarketLab Cloud";
const DEFAULT_VERSION = "2.1.0";
const QUOTE_TTL_SECONDS = 30;
const HISTORY_TTL_SECONDS = 15 * 60;
const SPLIT_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_JSON_BYTES = 5_000_000;

const NAMES = {
  AAPL: "Apple",
  MSFT: "Microsoft",
  NVDA: "NVIDIA",
  IBM: "IBM",
  SPY: "SPDR S&P 500 ETF",
  QQQ: "Invesco QQQ ETF",
  TSLA: "Tesla",
  KLAC: "KLA Corporation",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function nowIso() {
  return new Date().toISOString();
}

function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeSymbol(value) {
  const result = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9.\-:]/g, "");
  if (!result || result.length > 20) throw new Error("Invalid symbol");
  return result;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function withSecurity(response, noStore = false) {
  const headers = new Headers(response.headers);
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => headers.set(key, value));
  if (noStore) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function parseCookies(request) {
  const result = {};
  const raw = request.headers.get("Cookie") || "";
  for (const pair of raw.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    result[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return result;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stringToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToString(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function safeEqual(left, right) {
  const [a, b] = await Promise.all([sha256(String(left)), sha256(String(right))]);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function signText(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function createSession(env) {
  const payload = JSON.stringify({ exp: epochSeconds() + SESSION_TTL_SECONDS, nonce: crypto.randomUUID() });
  const encoded = stringToBase64Url(payload);
  const secret = env.SESSION_SECRET || `${env.MARKETLAB_PASSWORD}:marketlab-session`;
  return `${encoded}.${await signText(encoded, secret)}`;
}

async function verifySession(request, env) {
  if (!env.MARKETLAB_PASSWORD) return false;
  const token = parseCookies(request).ml_session;
  if (!token || !token.includes(".")) return false;
  const [encoded, signature] = token.split(".", 2);
  const secret = env.SESSION_SECRET || `${env.MARKETLAB_PASSWORD}:marketlab-session`;
  const expected = await signText(encoded, secret);
  if (!(await safeEqual(signature, expected))) return false;
  try {
    const payload = JSON.parse(base64UrlToString(encoded));
    return Number(payload.exp) > epochSeconds();
  } catch {
    return false;
  }
}

function sessionCookie(token) {
  return `ml_session=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie() {
  return "ml_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
}

function loginPage(message = "") {
  const escaped = String(message).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#061522"><title>MarketLab sign in</title><style>html{background:#061522;color:#eaf4ff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{min-height:100vh;display:grid;place-items:center;margin:0;padding:24px}.card{width:min(420px,100%);background:#0c2134;border:1px solid #29455e;border-radius:28px;padding:28px;box-sizing:border-box;box-shadow:0 24px 80px #0008}.logo{font-size:34px;font-weight:900}.sub{color:#9db3c8;margin:8px 0 28px;line-height:1.5}label{display:block;font-weight:700;margin-bottom:8px}input{width:100%;box-sizing:border-box;border-radius:16px;border:1px solid #385770;background:#071827;color:#fff;padding:16px;font-size:18px}button{width:100%;margin-top:16px;border:0;border-radius:16px;background:#55a8ff;color:#04111d;padding:16px;font-size:18px;font-weight:900}.error{background:#4e2431;color:#ffb8c5;padding:12px;border-radius:14px;margin-bottom:18px}.note{font-size:13px;color:#88a2b8;margin-top:18px;line-height:1.5}</style></head><body><form class="card" method="post" action="/auth/login"><div class="logo">MarketLab ☁️</div><div class="sub">Private beginner-friendly paper trading. Your provider keys stay inside Cloudflare and are never sent to Safari.</div>${escaped ? `<div class="error">${escaped}</div>` : ""}<label for="password">Private password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Open MarketLab</button><div class="note">Educational simulation only. MarketLab cannot execute real brokerage orders.</div></form></body></html>`;
}

function importPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#061522"><title>Import MarketLab data</title><style>body{margin:0;background:#061522;color:#eaf4ff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:22px}.wrap{max-width:700px;margin:auto}.card{background:#0c2134;border:1px solid #29455e;border-radius:22px;padding:20px;margin:14px 0}h1{margin-bottom:6px}.muted{color:#9db3c8;line-height:1.55}input,button{width:100%;box-sizing:border-box;padding:14px;border-radius:14px;font-size:16px}input{border:1px solid #385770;background:#071827;color:#fff}button{border:0;background:#55a8ff;font-weight:800;margin-top:12px}.secondary{background:#243d52;color:#fff}pre{white-space:pre-wrap;background:#071827;padding:14px;border-radius:14px;min-height:70px}a{color:#7ebcff}</style></head><body><div class="wrap"><h1>Import from local MarketLab</h1><p class="muted">Upload JSON files saved from the local iSH app. You can select state, trades, and reviews files together. Existing cloud rows are preserved; duplicate trade IDs are ignored.</p><div class="card"><input id="files" type="file" accept="application/json,.json" multiple><button id="import">Import selected files</button><button class="secondary" id="export">Download cloud backup</button><pre id="result">Waiting for files…</pre></div><div class="card"><b>Local export addresses</b><p class="muted">While the old iSH server is running, open each address in Safari and save the JSON to Files:</p><p><code>http://127.0.0.1:8000/api/state</code><br><code>http://127.0.0.1:8000/api/trades?limit=100000</code><br><code>http://127.0.0.1:8000/api/trade-reviews</code></p><a href="/">← Return to MarketLab</a></div></div><script>const out=document.querySelector('#result');document.querySelector('#import').onclick=async()=>{const files=[...document.querySelector('#files').files];if(!files.length)return out.textContent='Choose at least one JSON file.';const summary=[];for(const file of files){try{const data=JSON.parse(await file.text());const response=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Import failed');summary.push(file.name+': '+JSON.stringify(result));}catch(error){summary.push(file.name+': ERROR '+error.message)}}out.textContent=summary.join('\n\n')};document.querySelector('#export').onclick=()=>location.href='/api/export';</script></body></html>`;
}

async function ensureSchema(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") throw new Error("D1 binding DB is missing. Add the marketlab-db binding with variable name DB.");
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, trade_time TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, fee REAL NOT NULL DEFAULT 0, json TEXT NOT NULL, created_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS trade_reviews (trade_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS market_cache (cache_key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL)"),
  ]);
}

async function readJsonBody(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_JSON_BYTES) throw new Error("Payload exceeds 5 MB");
  const text = await request.text();
  if (!text || text.length > MAX_JSON_BYTES) throw new Error("Invalid payload size");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Payload must be a JSON object");
  return parsed;
}

async function getCache(env, key, allowExpired = false) {
  const row = await env.DB.prepare("SELECT json, fetched_at, expires_at FROM market_cache WHERE cache_key = ?").bind(key).first();
  if (!row) return null;
  if (!allowExpired && Number(row.expires_at) <= epochSeconds()) return null;
  try {
    return { value: JSON.parse(row.json), fetchedAt: row.fetched_at, expired: Number(row.expires_at) <= epochSeconds() };
  } catch {
    return null;
  }
}

async function putCache(env, key, value, ttlSeconds) {
  const fetchedAt = nowIso();
  await env.DB.prepare("INSERT INTO market_cache(cache_key,json,fetched_at,expires_at) VALUES(?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET json=excluded.json,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at")
    .bind(key, JSON.stringify(value), fetchedAt, epochSeconds() + ttlSeconds).run();
  return fetchedAt;
}

async function providerJson(url, providerName) {
  const response = await fetch(url, { headers: { "User-Agent": `MarketLab-Cloud/${DEFAULT_VERSION}` } });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${providerName} returned an invalid response (${response.status})`); }
  if (!response.ok) throw new Error(`${providerName} request failed (${response.status})`);
  return payload;
}

function twelveError(payload, fallback = "Twelve Data quote unavailable") {
  const message = String(payload?.message || payload?.detail || payload?.code || fallback);
  if (/credit|rate limit|too many/i.test(message)) return "Twelve Data rate limit reached. Wait for the next minute before refreshing again.";
  return message;
}

function quoteTime(item) {
  const timestamp = finiteNumber(item?.timestamp, NaN);
  if (Number.isFinite(timestamp)) return new Date(timestamp * 1000).toISOString();
  return String(item?.datetime || item?.last_update_at || nowIso());
}

function parseTwelveQuote(item, requestedSymbol = "") {
  if (!item || typeof item !== "object") throw new Error("Twelve Data returned an invalid quote");
  if (item.status === "error" || (item.code && item.close == null && item.price == null)) throw new Error(twelveError(item));
  const symbol = normalizeSymbol(item.symbol || requestedSymbol);
  const price = finiteNumber(item.close ?? item.price, NaN);
  if (!(price > 0)) throw new Error(`Twelve Data did not return a current price for ${symbol}`);
  const previousClose = finiteNumber(item.previous_close, price);
  const change = finiteNumber(item.change, price - previousClose);
  const changePercent = finiteNumber(item.percent_change, previousClose ? (change / previousClose) * 100 : 0);
  return {
    symbol,
    name: String(item.name || NAMES[symbol] || symbol),
    price,
    previousClose,
    change: Number(change.toFixed(6)),
    changePercent: Number(changePercent.toFixed(6)),
    currency: String(item.currency || "USD"),
    marketDataAt: quoteTime(item),
    retrievedAt: nowIso(),
    provider: "Twelve Data /quote",
    freshness: "real-time quote",
    dataMode: "provider",
    exchange: item.exchange || null,
    isMarketOpen: item.is_market_open ?? null,
  };
}

async function currentQuote(env, symbol, force = false) {
  symbol = normalizeSymbol(symbol);
  if (!env.TWELVE_DATA_API_KEY) throw new Error("Twelve Data key is not configured in Cloudflare secrets.");
  const key = `quote:${symbol}`;
  if (!force) {
    const cached = await getCache(env, key);
    if (cached) return { quote: cached.value, cached: true };
  }
  const url = new URL("https://api.twelvedata.com/quote");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);
  const payload = await providerJson(url, "Twelve Data");
  const quote = parseTwelveQuote(payload, symbol);
  await putCache(env, key, quote, QUOTE_TTL_SECONDS);
  return { quote, cached: false };
}

function alphaError(payload, fallback = "Alpha Vantage data unavailable") {
  const message = String(payload?.Information || payload?.Note || payload?.["Error Message"] || fallback);
  if (/frequency|rate limit|1 request per second/i.test(message)) return "Alpha Vantage rate limit reached. Wait before requesting history again.";
  return message;
}

async function alphaJson(env, params) {
  if (!env.ALPHA_VANTAGE_API_KEY) throw new Error("Alpha Vantage key is not configured in Cloudflare secrets.");
  const url = new URL("https://www.alphavantage.co/query");
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("apikey", env.ALPHA_VANTAGE_API_KEY);
  return providerJson(url, "Alpha Vantage");
}

function parseAlphaHistory(payload) {
  const series = payload?.["Time Series (Daily)"];
  if (!series || typeof series !== "object") throw new Error(alphaError(payload, "Alpha Vantage did not return daily history"));
  return Object.entries(series).sort(([left], [right]) => left.localeCompare(right)).map(([date, row]) => ({
    date,
    open: finiteNumber(row["1. open"]),
    high: finiteNumber(row["2. high"]),
    low: finiteNumber(row["3. low"]),
    close: finiteNumber(row["4. close"]),
    volume: Math.trunc(finiteNumber(row["5. volume"])),
  })).filter((row) => row.open > 0 && row.high > 0 && row.low > 0 && row.close > 0);
}

function parseSplitEvents(payload) {
  let rows = payload?.data || payload?.splits || [];
  if (rows && !Array.isArray(rows) && typeof rows === "object") rows = Object.entries(rows).map(([date, value]) => typeof value === "object" ? { ...value, effective_date: date } : { effective_date: date, split_factor: value });
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const effectiveDate = String(row?.effective_date || row?.date || row?.split_date || "").slice(0, 10);
    const factor = finiteNumber(row?.split_factor ?? row?.split_coefficient ?? row?.factor ?? row?.ratio, NaN);
    return { effectiveDate, factor };
  }).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.effectiveDate) && row.factor > 0 && Math.abs(row.factor - 1) > 1e-12).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

function applySplitAdjustments(rows, splits) {
  const events = [...(Array.isArray(splits) ? splits : [])].sort((a, b) => String(a.effectiveDate).localeCompare(String(b.effectiveDate)));
  return rows.map((row) => {
    let factor = 1;
    for (const event of events) if (String(event.effectiveDate) > String(row.date)) factor *= finiteNumber(event.factor, 1);
    const result = { ...row, splitAdjustmentFactor: factor };
    for (const field of ["open", "high", "low", "close"]) {
      const raw = finiteNumber(row[field]);
      const title = field[0].toUpperCase() + field.slice(1);
      result[`raw${title}`] = raw;
      result[`adjusted${title}`] = Number((raw / factor).toFixed(8));
    }
    result.rawVolume = Math.trunc(finiteNumber(row.volume));
    result.adjustedVolume = Math.trunc(result.rawVolume * factor);
    return result;
  });
}

async function twelveHistory(env, symbol) {
  if (!env.TWELVE_DATA_API_KEY) throw new Error("No history provider configured");
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1day");
  url.searchParams.set("outputsize", "500");
  url.searchParams.set("order", "ASC");
  url.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);
  const payload = await providerJson(url, "Twelve Data");
  if (payload?.status === "error") throw new Error(twelveError(payload, "Twelve Data history unavailable"));
  const values = payload?.values || payload?.data || [];
  return (Array.isArray(values) ? values : []).map((row) => ({
    date: String(row.datetime || row.date || "").slice(0, 10),
    open: finiteNumber(row.open), high: finiteNumber(row.high), low: finiteNumber(row.low), close: finiteNumber(row.close), volume: Math.trunc(finiteNumber(row.volume)),
  })).filter((row) => row.date && row.close > 0).sort((a, b) => a.date.localeCompare(b.date));
}

async function loadHistory(env, symbol, force = false) {
  const key = `history:${symbol}`;
  if (!force) {
    const cached = await getCache(env, key);
    if (cached) return { rows: cached.value.rows || cached.value, provider: cached.value.provider || "Cached history", cached: true };
  }
  let rows;
  let provider;
  if (env.ALPHA_VANTAGE_API_KEY) {
    try {
      rows = parseAlphaHistory(await alphaJson(env, { function: "TIME_SERIES_DAILY", symbol, outputsize: "compact" }));
      provider = "Alpha Vantage";
    } catch (error) {
      if (!env.TWELVE_DATA_API_KEY) throw error;
      rows = await twelveHistory(env, symbol);
      provider = "Twelve Data history (Alpha Vantage fallback)";
    }
  } else {
    rows = await twelveHistory(env, symbol);
    provider = "Twelve Data";
  }
  if (rows.length < 2) throw new Error("The provider returned too little daily history");
  await putCache(env, key, { rows, provider }, HISTORY_TTL_SECONDS);
  return { rows, provider, cached: false };
}

async function loadSplits(env, symbol, force = false) {
  if (!env.ALPHA_VANTAGE_API_KEY) return { splits: [], status: "unavailable", cached: false };
  const key = `splits:${symbol}`;
  if (!force) {
    const cached = await getCache(env, key);
    if (cached) return { splits: cached.value, status: "cached", cached: true };
  }
  const stale = await getCache(env, key, true);
  try {
    const payload = await alphaJson(env, { function: "SPLITS", symbol });
    if (payload?.Information || payload?.Note || payload?.["Error Message"]) throw new Error(alphaError(payload, "Split data unavailable"));
    const splits = parseSplitEvents(payload);
    await putCache(env, key, splits, SPLIT_TTL_SECONDS);
    return { splits, status: "available", cached: false };
  } catch (error) {
    if (stale) return { splits: stale.value, status: "stale", cached: true, warning: String(error.message || error) };
    return { splits: [], status: "unavailable", cached: false, warning: String(error.message || error) };
  }
}

async function marketSnapshot(env, rawSymbol, force = false) {
  const symbol = normalizeSymbol(rawSymbol);
  const forceHistory = force && !env.TWELVE_DATA_API_KEY;
  const history = await loadHistory(env, symbol, forceHistory);
  const splitResult = await loadSplits(env, symbol, forceHistory);
  const points = applySplitAdjustments(history.rows, splitResult.splits);
  const latest = points.at(-1);
  const previous = points.at(-2);
  const latestRaw = finiteNumber(latest.rawClose, latest.close);
  const previousRaw = finiteNumber(previous.rawClose, previous.close);
  const historicalQuote = {
    symbol,
    name: NAMES[symbol] || symbol,
    price: latestRaw,
    previousClose: previousRaw,
    change: Number((latestRaw - previousRaw).toFixed(4)),
    changePercent: previousRaw ? Number((((latestRaw - previousRaw) / previousRaw) * 100).toFixed(4)) : 0,
    currency: "USD",
    marketDataAt: latest.date,
    retrievedAt: nowIso(),
    provider: `${history.provider} daily history${env.ALPHA_VANTAGE_API_KEY ? " + SPLITS" : ""}`,
    freshness: "end-of-day",
    dataMode: "provider",
  };
  let quote = historicalQuote;
  let quoteFallbackReason = null;
  if (env.TWELVE_DATA_API_KEY) {
    try { quote = (await currentQuote(env, symbol, force)).quote; }
    catch (error) { quoteFallbackReason = String(error.message || error); }
  }
  return {
    schemaVersion: 3,
    quote,
    historicalQuote,
    quoteFallbackReason,
    points,
    splits: splitResult.splits,
    splitDataStatus: splitResult.status,
    adjustedForSplits: splitResult.splits.length > 0,
    provider: `${quote.provider} + ${history.provider} history`,
    dataMode: "provider",
    retrievedAt: nowIso(),
    cached: history.cached,
  };
}

async function insertTrade(env, trade) {
  if (!trade || typeof trade !== "object") throw new Error("Trade must be an object");
  const value = { ...trade };
  value.id = String(value.id || crypto.randomUUID());
  value.symbol = normalizeSymbol(value.symbol);
  value.side = value.side === "sell" ? "sell" : "buy";
  value.qty = Math.max(0, finiteNumber(value.qty ?? value.quantity));
  value.price = Math.max(0, finiteNumber(value.price));
  value.fee = Math.max(0, finiteNumber(value.fee));
  value.time = String(value.time || nowIso());
  if (!(value.qty > 0) || !(value.price > 0)) throw new Error("Trade quantity and price must be positive");
  const result = await env.DB.prepare("INSERT OR IGNORE INTO trades(id,trade_time,symbol,side,qty,price,fee,json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(value.id, value.time, value.symbol, value.side, value.qty, value.price, value.fee, JSON.stringify(value), nowIso()).run();
  return { inserted: Number(result.meta?.changes || 0) > 0, trade: value };
}

async function listTrades(env, limit = 1000) {
  const safeLimit = Math.max(1, Math.min(100000, Math.trunc(finiteNumber(limit, 1000))));
  const result = await env.DB.prepare("SELECT json FROM trades ORDER BY COALESCE(trade_time,created_at) DESC LIMIT ?").bind(safeLimit).all();
  return (result.results || []).map((row) => { try { return JSON.parse(row.json); } catch { return null; } }).filter(Boolean);
}

async function tradeCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM trades").first();
  return Number(row?.count || 0);
}

async function reviewCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM trade_reviews").first();
  return Number(row?.count || 0);
}

async function readReviews(env) {
  const rows = await env.DB.prepare("SELECT trade_id,json FROM trade_reviews ORDER BY updated_at DESC").all();
  const reviews = {};
  for (const row of rows.results || []) { try { reviews[row.trade_id] = JSON.parse(row.json); } catch {} }
  return reviews;
}

async function saveReview(env, tradeId, review) {
  await env.DB.prepare("INSERT INTO trade_reviews(trade_id,json,updated_at) VALUES(?,?,?) ON CONFLICT(trade_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at")
    .bind(tradeId, JSON.stringify(review), nowIso()).run();
}

async function readState(env) {
  const row = await env.DB.prepare("SELECT json FROM app_state WHERE id=1").first();
  let state = {};
  if (row?.json) { try { state = JSON.parse(row.json); } catch {} }
  const trades = await listTrades(env, 100000);
  if (trades.length) state.trades = trades;
  return state;
}

async function writeState(env, state) {
  // Trades and reviews have their own authoritative D1 tables. Avoid rewriting the
  // full ledger on every UI preference change; readState reattaches it on load.
  const compactState = { ...state };
  delete compactState.trades;
  delete compactState.tradeReviews;
  const encoded = JSON.stringify(compactState);
  if (encoded.length > MAX_JSON_BYTES) throw new Error("State exceeds 5 MB");
  await env.DB.prepare("INSERT INTO app_state(id,json,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at")
    .bind(encoded, nowIso()).run();
}

function localSuggestions(state, scope, symbol, question = "") {
  const positions = Array.isArray(state?.positions) ? state.positions : [];
  const quotes = state?.quotes && typeof state.quotes === "object" ? state.quotes : {};
  const selected = normalizeSymbol(symbol || state?.symbol || "KLAC");
  const suggestions = [];
  if (!positions.length) suggestions.push({ title: "Start with a small learning position", signal: "neutral", text: "There are no open simulated positions yet.", evidence: ["0 open positions"], action: "Write a clear thesis, then test one small paper trade." });
  const gross = positions.reduce((sum, position) => sum + Math.abs(finiteNumber(position.qty) * finiteNumber(quotes[position.symbol]?.price, position.avg)), 0);
  const largest = positions.map((position) => ({ ...position, exposure: Math.abs(finiteNumber(position.qty) * finiteNumber(quotes[position.symbol]?.price, position.avg)) })).sort((a, b) => b.exposure - a.exposure)[0];
  if (largest && gross > 0) {
    const concentration = (largest.exposure / gross) * 100;
    suggestions.push({ title: "Check concentration risk", signal: concentration > 40 ? "warning" : "neutral", text: `${largest.symbol} represents about ${concentration.toFixed(1)}% of gross exposure.`, evidence: [`Gross exposure: $${gross.toFixed(2)}`, `Largest position: ${largest.symbol}`], action: "Use the What-if simulator to test a 10% adverse move." });
  }
  const position = positions.find((item) => String(item.symbol).toUpperCase() === selected);
  if (scope === "symbol") suggestions.push({ title: `${selected} decision checklist`, signal: position ? "neutral" : "warning", text: position ? "Compare the current price with your entry thesis and invalidation level." : "You do not currently hold a simulated position in this symbol.", evidence: [position ? `Quantity: ${position.qty}` : "No open position", question ? `Question: ${question}` : "No optional question"], action: "Record what evidence would change your mind before placing another trade." });
  if (!suggestions.length) suggestions.push({ title: "Review your process", signal: "neutral", text: "The loaded data do not show an obvious single risk signal.", evidence: ["Analysis uses only MarketLab data"], action: "Compare each position against SPY and QQQ and review the original thesis." });
  return {
    mode: "local",
    provider: "MarketLab cloud rules",
    model: "local-rules-v2",
    generatedAt: nowIso(),
    scope,
    symbol: selected,
    summary: `Educational review of ${scope === "symbol" ? selected : `${positions.length} open position(s)`}.`,
    stance: "Balanced learning review",
    confidence: positions.length ? 70 : 45,
    suggestions: suggestions.slice(0, 6),
    limitations: ["Uses only data loaded into MarketLab.", "Does not know personal suitability, taxes, current news, or complete fundamentals.", "This is educational paper trading, not financial advice."],
  };
}

function extractOpenAIText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const texts = [];
  for (const output of payload?.output || []) for (const content of output?.content || []) if (typeof content?.text === "string") texts.push(content.text);
  return texts.join("\n");
}

function parseJsonText(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("OpenAI did not return valid JSON");
  }
}

async function callOpenAI(env, instructions, input, maxOutputTokens = 1200) {
  if (!env.OPENAI_API_KEY) throw new Error("OpenAI key is not configured");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.OPENAI_MODEL || "gpt-5.6-luna", instructions, input: JSON.stringify(input), max_output_tokens: maxOutputTokens, store: false }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI request failed (${response.status})`);
  return parseJsonText(extractOpenAIText(payload));
}

async function generateSuggestions(env, payload) {
  const state = payload.state && typeof payload.state === "object" ? payload.state : await readState(env);
  const scope = payload.scope === "symbol" ? "symbol" : "portfolio";
  const symbol = normalizeSymbol(payload.symbol || state.symbol || "KLAC");
  const question = String(payload.question || "").slice(0, 500);
  const baseline = localSuggestions(state, scope, symbol, question);
  if (!env.OPENAI_API_KEY) return baseline;
  try {
    const result = await callOpenAI(env,
      "You are the beginner-friendly educational AI coach in MarketLab, a paper-trading simulator. Use only supplied data. Never execute trades, promise returns, or claim access to missing news/fundamentals. Return JSON only with summary, stance, confidence (0-100), suggestions (3-6 objects: title, signal positive|negative|neutral|warning, text, evidence array, action), and limitations array.",
      { scope, symbol, question, state: { positions: state.positions || [], quotes: state.quotes || {}, history: state.history || {}, trades: (state.trades || []).slice(0, 50) }, localBaseline: baseline }, 1400);
    return {
      ...baseline,
      mode: "openai",
      provider: "OpenAI Responses API",
      model: env.OPENAI_MODEL || "gpt-5.6-luna",
      generatedAt: nowIso(),
      summary: String(result.summary || baseline.summary).slice(0, 1200),
      stance: String(result.stance || baseline.stance).slice(0, 200),
      confidence: Math.max(0, Math.min(100, Math.trunc(finiteNumber(result.confidence, baseline.confidence)))),
      suggestions: Array.isArray(result.suggestions) ? result.suggestions.slice(0, 6) : baseline.suggestions,
      limitations: Array.isArray(result.limitations) ? result.limitations.slice(0, 6) : baseline.limitations,
    };
  } catch (error) {
    return { ...baseline, mode: "local-fallback", warning: `OpenAI unavailable: ${String(error.message || error).slice(0, 240)}` };
  }
}

function localTradeReview(payload) {
  const trade = payload.trade || {};
  const result = payload.result || {};
  const journal = trade.journal || {};
  const pnlValue = finiteNumber(result.resultValue);
  const pnlPercent = finiteNumber(result.resultPercent);
  const preparation = [journal.thesis, journal.expectedHolding, journal.targetPrice, journal.invalidationPrice, journal.notes].filter((value) => String(value || "").trim()).length;
  const preparationScore = Math.min(100, 25 + preparation * 15);
  const outcome = pnlValue > 0 ? "profitable" : pnlValue < 0 ? "unprofitable" : "flat";
  return {
    tradeId: String(trade.id || result.id || ""),
    symbol: String(trade.symbol || result.symbol || ""),
    provider: "MarketLab cloud post-trade review",
    model: "local-rules-v2",
    generatedAt: nowIso(),
    outcome,
    decisionQuality: preparationScore >= 70 ? "Documented decision" : "Needs a clearer decision record",
    preparationScore,
    summary: `${String(trade.symbol || "Trade")} was ${outcome} at ${pnlValue >= 0 ? "+" : ""}${pnlValue.toFixed(2)} USD (${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%).`,
    evidence: [`Status: ${String(result.statusLabel || result.status || "unknown")}`, `Journal fields completed: ${preparation}/5`],
    lessons: [pnlValue > 0 ? "A profit does not prove the original reasoning was correct; compare the result with the written thesis." : "A loss can still come from a disciplined decision; review whether the invalidation rule was followed.", "Compare the same period with SPY and QQQ before judging stock selection."],
    limitations: ["Uses only the submitted trade, journal, prices, and benchmarks.", "Does not know news, taxes, or personal suitability."],
  };
}

async function generateTradeReview(env, payload) {
  const baseline = localTradeReview(payload);
  let review = baseline;
  if (env.OPENAI_API_KEY) {
    try {
      const result = await callOpenAI(env,
        "You are a beginner-friendly educational post-trade reviewer inside a paper-trading simulator. Use only supplied JSON. Distinguish decision quality from financial outcome. Return JSON only with summary, outcome, decisionQuality, preparationScore, evidence, lessons, limitations.",
        { trade: payload.trade, result: payload.result, benchmarks: payload.benchmarks, localBaseline: baseline }, 1000);
      review = { ...baseline, ...result, provider: "OpenAI post-trade review", model: env.OPENAI_MODEL || "gpt-5.6-luna", generatedAt: nowIso(), tradeId: baseline.tradeId, symbol: baseline.symbol };
    } catch (error) { review = { ...baseline, warning: `OpenAI review unavailable: ${String(error.message || error).slice(0, 240)}` }; }
  }
  if (review.tradeId) await saveReview(env, review.tradeId, review);
  return review;
}

async function exportData(env) {
  const state = await readState(env);
  const trades = await listTrades(env, 100000);
  const reviews = await readReviews(env);
  return { format: "marketlab-cloud-backup", version: 2, exportedAt: nowIso(), state, trades, reviews };
}

async function importData(env, payload) {
  const state = payload.state?.state && typeof payload.state.state === "object" ? payload.state.state : payload.state && typeof payload.state === "object" ? payload.state : payload.state === undefined && payload.trades === undefined && payload.reviews === undefined && payload.version ? payload : null;
  const trades = Array.isArray(payload.trades) ? payload.trades : Array.isArray(state?.trades) ? state.trades : [];
  const reviews = payload.reviews && typeof payload.reviews === "object" && !Array.isArray(payload.reviews) ? payload.reviews : {};
  let importedTrades = 0;
  for (const trade of trades) if ((await insertTrade(env, trade)).inserted) importedTrades += 1;
  let importedReviews = 0;
  for (const [tradeId, review] of Object.entries(reviews)) if (review && typeof review === "object") { await saveReview(env, tradeId, review); importedReviews += 1; }
  if (state) await writeState(env, { ...state, trades: await listTrades(env, 100000) });
  return { imported: true, importedTrades, importedReviews, stateImported: Boolean(state), totalTrades: await tradeCount(env) };
}

async function handleApi(request, env, url) {
  await ensureSchema(env);
  const method = request.method.toUpperCase();
  if (url.pathname === "/api/health" && method === "GET") {
    return jsonResponse({
      status: "ok", service: "marketlab-cloud", version: env.APP_VERSION || DEFAULT_VERSION, backend: "Cloudflare Worker + D1",
      marketDataMode: env.TWELVE_DATA_API_KEY ? "real-time-provider" : env.ALPHA_VANTAGE_API_KEY ? "provider" : "not-configured",
      liveQuoteProvider: env.TWELVE_DATA_API_KEY ? "Twelve Data" : null, liveQuotesConfigured: Boolean(env.TWELVE_DATA_API_KEY),
      historicalDataProvider: env.ALPHA_VANTAGE_API_KEY ? "Alpha Vantage" : env.TWELVE_DATA_API_KEY ? "Twelve Data" : null,
      alphaVantageConfigured: Boolean(env.ALPHA_VANTAGE_API_KEY), brokerageExecution: false,
      aiMode: env.OPENAI_API_KEY ? "openai" : "local", aiConfigured: Boolean(env.OPENAI_API_KEY), aiModel: env.OPENAI_API_KEY ? (env.OPENAI_MODEL || "gpt-5.6-luna") : "local-rules-v2",
      persistentDataDirectory: "Cloudflare D1", tradeDatabase: "D1 binding: DB", tradeCount: await tradeCount(env), tradeReviewCount: await reviewCount(env), keysPersisted: Boolean(env.TWELVE_DATA_API_KEY || env.ALPHA_VANTAGE_API_KEY || env.OPENAI_API_KEY), checkedAt: nowIso(),
    });
  }
  if (url.pathname === "/api/state" && method === "GET") return jsonResponse({ state: await readState(env) });
  if (url.pathname === "/api/state" && method === "POST") { const payload = await readJsonBody(request); await writeState(env, payload); return jsonResponse({ saved: true, savedAt: nowIso(), tradeCount: await tradeCount(env) }); }
  if (url.pathname === "/api/trades" && method === "GET") { const trades = await listTrades(env, url.searchParams.get("limit") || 1000); return jsonResponse({ trades, count: await tradeCount(env), database: "Cloudflare D1" }); }
  if (url.pathname === "/api/trades" && method === "POST") { const payload = await readJsonBody(request); const saved = await insertTrade(env, payload.trade && typeof payload.trade === "object" ? payload.trade : payload); return jsonResponse({ saved: true, inserted: saved.inserted, tradeCount: await tradeCount(env), savedAt: nowIso() }); }
  if (url.pathname === "/api/trade-reviews" && method === "GET") { const reviews = await readReviews(env); return jsonResponse({ reviews, count: Object.keys(reviews).length, database: "Cloudflare D1" }); }
  if (url.pathname === "/api/quotes" && method === "GET") {
    const symbols = [...new Set(String(url.searchParams.get("symbols") || "").split(",").filter(Boolean).map(normalizeSymbol))];
    if (!symbols.length) throw new Error("At least one symbol is required");
    const force = ["1", "true", "yes"].includes(String(url.searchParams.get("force") || "0").toLowerCase());
    const quotes = {}; const errors = {}; const cachedSymbols = [];
    for (const symbol of symbols) {
      try { const result = await currentQuote(env, symbol, force); quotes[symbol] = result.quote; if (result.cached) cachedSymbols.push(symbol); }
      catch (error) { errors[symbol] = String(error.message || error); }
    }
    return jsonResponse({ quotes, errors, count: Object.keys(quotes).length, requested: symbols, cachedSymbols, provider: "Twelve Data /quote" });
  }
  if (["/api/market", "/api/quote", "/api/history"].includes(url.pathname) && method === "GET") {
    const symbol = normalizeSymbol(url.searchParams.get("symbol"));
    const force = ["1", "true", "yes"].includes(String(url.searchParams.get("force") || "0").toLowerCase());
    const snapshot = await marketSnapshot(env, symbol, force);
    if (url.pathname === "/api/market") return jsonResponse({ symbol, ...snapshot });
    if (url.pathname === "/api/quote") return jsonResponse({ quote: snapshot.quote, cached: snapshot.cached });
    return jsonResponse({ symbol, points: snapshot.points, splits: snapshot.splits, splitDataStatus: snapshot.splitDataStatus, adjustedForSplits: snapshot.adjustedForSplits, provider: snapshot.provider, dataMode: snapshot.dataMode, cached: snapshot.cached });
  }
  if (url.pathname === "/api/ai/suggestions" && method === "POST") return jsonResponse(await generateSuggestions(env, await readJsonBody(request)));
  if (url.pathname === "/api/ai/trade-review" && method === "POST") return jsonResponse(await generateTradeReview(env, await readJsonBody(request)));
  if (url.pathname === "/api/backup" && method === "POST") {
    const backup = await exportData(env); const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO backups(id,json,created_at) VALUES(?,?,?)").bind(id, JSON.stringify(backup), nowIso()).run();
    return jsonResponse({ saved: true, backupId: id, createdAt: backup.exportedAt, files: ["D1 backup snapshot"] });
  }
  if (url.pathname === "/api/export" && method === "GET") {
    const backup = await exportData(env);
    return new Response(JSON.stringify(backup, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="marketlab-cloud-backup-${new Date().toISOString().slice(0, 10)}.json"`, "Cache-Control": "no-store", ...SECURITY_HEADERS } });
  }
  if (url.pathname === "/api/import" && method === "POST") return jsonResponse(await importData(env, await readJsonBody(request)));
  return jsonResponse({ error: "Not found" }, 404);
}

async function workerFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return jsonResponse({ status: "ok", service: "marketlab-cloud", version: env.APP_VERSION || DEFAULT_VERSION });
  if (url.pathname === "/manifest.webmanifest" || url.pathname === "/service-worker.js" || url.pathname.startsWith("/icon")) return withSecurity(await env.ASSETS.fetch(request));

  if (url.pathname === "/auth/login" && request.method === "POST") {
    if (!env.MARKETLAB_PASSWORD) return htmlResponse(loginPage("MARKETLAB_PASSWORD is not configured as a Cloudflare secret."), 503);
    const form = await request.formData();
    if (!(await safeEqual(form.get("password") || "", env.MARKETLAB_PASSWORD))) return htmlResponse(loginPage("Incorrect password."), 401);
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": sessionCookie(await createSession(env)), ...SECURITY_HEADERS } });
  }
  if (url.pathname === "/logout" || url.pathname === "/auth/logout") return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": clearSessionCookie(), ...SECURITY_HEADERS } });

  const authenticated = await verifySession(request, env);
  if (!authenticated) {
    if (url.pathname.startsWith("/api/")) return jsonResponse({ error: "Authentication required" }, 401);
    return htmlResponse(loginPage(env.MARKETLAB_PASSWORD ? "" : "Deployment is not finished: add the MARKETLAB_PASSWORD secret."), env.MARKETLAB_PASSWORD ? 200 : 503);
  }

  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
    if (url.pathname === "/login") return new Response(null, { status: 303, headers: { Location: "/", ...SECURITY_HEADERS } });
    if (url.pathname === "/import") return htmlResponse(importPage());
    return withSecurity(await env.ASSETS.fetch(request));
  } catch (error) {
    console.error(error);
    if (url.pathname.startsWith("/api/")) return jsonResponse({ error: String(error.message || error) }, /Invalid|must|required|positive|missing/i.test(String(error.message || error)) ? 400 : 502);
    return htmlResponse(`<h1>MarketLab error</h1><p>${String(error.message || error)}</p>`, 500);
  }
}

export { applySplitAdjustments, normalizeSymbol, parseSplitEvents, parseTwelveQuote, safeEqual, workerFetch };

export default {
  fetch: workerFetch,
};
