import { workerFetch as legacyWorkerFetch } from "./worker.js";

const APP_VERSION = "2.2.1";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_JSON_BYTES = 5_000_000;
const PASSWORD_ITERATIONS = 100_000;
const MASTER_USER_ID = "master";
const USER_SESSION_COOKIE = "ml_user_session";
let schemaReadyPromise = null;

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

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9.\-:]/g, "");
  if (!symbol || symbol.length > 20) throw new Error("Invalid symbol");
  return symbol;
}

function normalizeUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new Error("Username must be 3–32 characters using letters, numbers, dot, underscore, or hyphen");
  }
  return username;
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
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

function securedResponse(response, noStore = false) {
  const headers = new Headers(response.headers);
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => headers.set(key, value));
  if (noStore) headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function stringToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToString(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
}

async function safeEqual(left, right) {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) diff |= (a[index] || 0) ^ (b[index] || 0);
  return diff === 0;
}

async function signText(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function sessionSecret(env) {
  return env.SESSION_SECRET || `${env.MARKETLAB_PASSWORD || "marketlab"}:marketlab-user-session`;
}

async function createUserSession(env, user) {
  const payload = {
    v: 1,
    uid: user.id,
    username: user.username,
    role: user.role,
    exp: epochSeconds() + SESSION_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  };
  const encoded = stringToBase64Url(JSON.stringify(payload));
  return `${encoded}.${await signText(encoded, sessionSecret(env))}`;
}

function userSessionCookie(token) {
  return `${USER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function derivePasswordHash(password, salt, iterations = PASSWORD_ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: base64UrlToBytes(salt),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

async function createPasswordRecord(password) {
  if (String(password || "").length < 8) throw new Error("Password must contain at least 8 characters");
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToBase64Url(saltBytes);
  const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);
  return { salt, hash, iterations: PASSWORD_ITERATIONS };
}

async function verifyPassword(password, user) {
  if (!user?.password_salt || !user?.password_hash) return false;
  const candidate = await derivePasswordHash(password, user.password_salt, finiteNumber(user.password_iterations, PASSWORD_ITERATIONS));
  return safeEqual(candidate, user.password_hash);
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

async function ensureMultiUserSchema(env) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = initializeMultiUserSchema(env).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

async function initializeMultiUserSchema(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") {
    throw new Error("D1 binding DB is missing. Add marketlab-db with binding name DB.");
  }
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, trade_time TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, fee REAL NOT NULL DEFAULT 0, json TEXT NOT NULL, created_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS trade_reviews (trade_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ml_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_salt TEXT, password_hash TEXT, password_iterations INTEGER, role TEXT NOT NULL DEFAULT 'user', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ml_user_state (user_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ml_user_trades (user_id TEXT NOT NULL, id TEXT NOT NULL, trade_time TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, fee REAL NOT NULL DEFAULT 0, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,id))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_ml_user_trades_time ON ml_user_trades(user_id,trade_time DESC)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ml_user_trade_reviews (user_id TEXT NOT NULL, trade_id TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,trade_id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ml_trade_audit (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, trade_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, changed_by TEXT NOT NULL, changed_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_ml_trade_audit_trade ON ml_trade_audit(user_id,trade_id,changed_at DESC)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ml_user_backups (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ml_migrations (migration_key TEXT PRIMARY KEY, completed_at TEXT NOT NULL)"),
  ]);

  const timestamp = nowIso();
  await env.DB.prepare("INSERT OR IGNORE INTO ml_users(id,username,display_name,password_salt,password_hash,password_iterations,role,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(MASTER_USER_ID, "master", "Master", "", "", 0, "master", 1, timestamp, timestamp)
    .run();

  await migrateLegacyDataToMaster(env);
}

async function migrateLegacyDataToMaster(env) {
  const migrationKey = "global-data-to-master-v1";
  const marker = await env.DB.prepare("SELECT migration_key FROM ml_migrations WHERE migration_key=?").bind(migrationKey).first();
  if (marker) return;

  const stateRow = await env.DB.prepare("SELECT json,updated_at FROM app_state WHERE id=1").first();
  if (stateRow?.json) {
    await env.DB.prepare("INSERT OR IGNORE INTO ml_user_state(user_id,json,updated_at) VALUES(?,?,?)")
      .bind(MASTER_USER_ID, stateRow.json, stateRow.updated_at || nowIso())
      .run();
  }

  const tradeRows = await env.DB.prepare("SELECT id,trade_time,symbol,side,qty,price,fee,json,created_at FROM trades").all();
  for (const row of tradeRows.results || []) {
    await env.DB.prepare("INSERT OR IGNORE INTO ml_user_trades(user_id,id,trade_time,symbol,side,qty,price,fee,json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .bind(MASTER_USER_ID, row.id, row.trade_time, row.symbol, row.side, row.qty, row.price, row.fee, row.json, row.created_at || nowIso(), row.created_at || nowIso())
      .run();
  }

  if (!(tradeRows.results || []).length && stateRow?.json) {
    try {
      const legacyState = JSON.parse(stateRow.json);
      for (const input of Array.isArray(legacyState.trades) ? legacyState.trades : []) {
        const trade = validateTrade(input);
        const timestamp = trade.time || nowIso();
        await env.DB.prepare("INSERT OR IGNORE INTO ml_user_trades(user_id,id,trade_time,symbol,side,qty,price,fee,json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .bind(MASTER_USER_ID, trade.id, trade.time, trade.symbol, trade.side, trade.qty, trade.price, trade.fee, JSON.stringify(trade), timestamp, timestamp)
          .run();
      }
    } catch {}
  }

  const reviewRows = await env.DB.prepare("SELECT trade_id,json,updated_at FROM trade_reviews").all();
  for (const row of reviewRows.results || []) {
    await env.DB.prepare("INSERT OR IGNORE INTO ml_user_trade_reviews(user_id,trade_id,json,updated_at) VALUES(?,?,?,?)")
      .bind(MASTER_USER_ID, row.trade_id, row.json, row.updated_at || nowIso())
      .run();
  }

  await env.DB.prepare("INSERT INTO ml_migrations(migration_key,completed_at) VALUES(?,?)")
    .bind(migrationKey, nowIso())
    .run();
}

async function getUserById(env, userId) {
  return env.DB.prepare("SELECT id,username,display_name,password_salt,password_hash,password_iterations,role,active,created_at,updated_at FROM ml_users WHERE id=?")
    .bind(userId)
    .first();
}

async function getUserByUsername(env, username) {
  return env.DB.prepare("SELECT id,username,display_name,password_salt,password_hash,password_iterations,role,active,created_at,updated_at FROM ml_users WHERE username=? COLLATE NOCASE")
    .bind(username)
    .first();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    active: Boolean(user.active),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

async function verifyUserSession(request, env) {
  const token = parseCookies(request)[USER_SESSION_COOKIE];
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".", 2);
  const expected = await signText(encoded, sessionSecret(env));
  if (!(await safeEqual(signature, expected))) return null;
  try {
    const payload = JSON.parse(base64UrlToString(encoded));
    if (payload.v !== 1 || Number(payload.exp) <= epochSeconds() || !payload.uid) return null;
    const user = await getUserById(env, payload.uid);
    if (!user || !Number(user.active)) return null;
    return publicUser(user);
  } catch {
    return null;
  }
}

function loginPage(message = "", username = "master") {
  const escapedMessage = htmlEscape(message);
  const escapedUsername = htmlEscape(username || "master");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#061522"><title>MarketLab sign in</title><style>html{background:#061522;color:#eaf4ff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{min-height:100vh;display:grid;place-items:center;margin:0;padding:24px}.card{width:min(420px,100%);background:#0c2134;border:1px solid #29455e;border-radius:28px;padding:28px;box-sizing:border-box;box-shadow:0 24px 80px #0008}.logo{font-size:34px;font-weight:900}.sub{color:#9db3c8;margin:8px 0 24px;line-height:1.5}.field{margin-top:14px}label{display:block;font-weight:700;margin-bottom:8px}input{width:100%;box-sizing:border-box;border-radius:16px;border:1px solid #385770;background:#071827;color:#fff;padding:16px;font-size:18px}button{width:100%;margin-top:18px;border:0;border-radius:16px;background:#55a8ff;color:#04111d;padding:16px;font-size:18px;font-weight:900}.error{background:#4e2431;color:#ffb8c5;padding:12px;border-radius:14px;margin-bottom:18px}.note{font-size:13px;color:#88a2b8;margin-top:18px;line-height:1.5}</style></head><body><form class="card" method="post" action="/auth/login"><div class="logo">MarketLab ☁️</div><div class="sub">Separate private paper-trading portfolio for every user.</div>${escapedMessage ? `<div class="error">${escapedMessage}</div>` : ""}<div class="field"><label for="username">Username</label><input id="username" name="username" value="${escapedUsername}" autocapitalize="none" autocomplete="username" required autofocus></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><button type="submit">Open MarketLab</button><div class="note">Existing trades belong to the <b>master</b> user. New users are created by master in Settings.</div></form></body></html>`;
}

async function authenticateLogin(env, usernameInput, password) {
  const username = normalizeUsername(usernameInput || "master");
  if (username === "master") {
    if (!env.MARKETLAB_PASSWORD || !(await safeEqual(password, env.MARKETLAB_PASSWORD))) return null;
    return getUserById(env, MASTER_USER_ID);
  }
  const user = await getUserByUsername(env, username);
  if (!user || !Number(user.active) || !(await verifyPassword(password, user))) return null;
  return user;
}

function validateTrade(input, existing = null) {
  const source = input?.trade && typeof input.trade === "object" ? input.trade : input;
  const merged = { ...(existing || {}), ...(source || {}) };
  const id = String(existing?.id || merged.id || crypto.randomUUID());
  const symbol = normalizeSymbol(merged.symbol);
  const side = merged.side === "sell" ? "sell" : "buy";
  const qty = Math.max(0, finiteNumber(merged.qty ?? merged.quantity));
  const price = Math.max(0, finiteNumber(merged.price));
  const fee = Math.max(0, finiteNumber(merged.fee));
  if (!(qty > 0)) throw new Error("Trade quantity must be positive");
  if (!(price > 0)) throw new Error("Trade execution price must be positive");
  const parsedTime = new Date(merged.time || merged.trade_time || nowIso());
  if (!Number.isFinite(parsedTime.getTime())) throw new Error("Trade date is invalid");
  const journal = merged.journal && typeof merged.journal === "object" ? {
    thesis: String(merged.journal.thesis || "").slice(0, 2000),
    expectedHolding: String(merged.journal.expectedHolding || "").slice(0, 500),
    targetPrice: String(merged.journal.targetPrice || "").slice(0, 100),
    invalidationPrice: String(merged.journal.invalidationPrice || "").slice(0, 100),
    confidence: String(merged.journal.confidence || "").slice(0, 20),
    notes: String(merged.journal.notes || "").slice(0, 4000),
  } : null;
  const trade = {
    ...merged,
    id,
    symbol,
    side,
    qty,
    price,
    fee,
    time: parsedTime.toISOString(),
    provider: String(merged.provider || "Manual / edited").slice(0, 200),
    journal,
  };
  delete trade.positionAfter;
  delete trade.realizedAfter;
  delete trade.resultValue;
  delete trade.resultPercent;
  delete trade.status;
  delete trade.statusLabel;
  return trade;
}

function rebuildLedgerState(baseState, sourceTrades) {
  const state = baseState && typeof baseState === "object" ? { ...baseState } : {};
  const chronological = (Array.isArray(sourceTrades) ? sourceTrades : [])
    .map((trade) => ({ ...trade }))
    .sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
  const positions = [];
  const derivedById = new Map();
  let cash = 0;

  for (const trade of chronological) {
    const symbol = normalizeSymbol(trade.symbol);
    const side = trade.side === "sell" ? "sell" : "buy";
    const quantity = Math.max(0, finiteNumber(trade.qty));
    const price = Math.max(0, finiteNumber(trade.price));
    const fee = Math.max(0, finiteNumber(trade.fee));
    if (!(quantity > 0) || !(price > 0)) continue;

    let position = positions.find((item) => item.symbol === symbol);
    const oldQty = finiteNumber(position?.qty);
    const oldAverage = finiteNumber(position?.avg, price);
    const oldRealized = finiteNumber(position?.realized);
    const delta = side === "buy" ? quantity : -quantity;
    const newQty = oldQty + delta;
    let newAverage = oldAverage;
    let realized = oldRealized;

    if (Math.abs(oldQty) < 1e-10 || Math.sign(oldQty) === Math.sign(delta)) {
      newAverage = (Math.abs(oldQty) * oldAverage + Math.abs(delta) * price) / Math.abs(newQty);
    } else {
      const closingQuantity = Math.min(Math.abs(oldQty), Math.abs(delta));
      realized += closingQuantity * (oldQty > 0 ? price - oldAverage : oldAverage - price);
      if (Math.abs(newQty) < 1e-10) newAverage = 0;
      else if (Math.sign(newQty) !== Math.sign(oldQty)) newAverage = price;
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

    cash += side === "buy" ? -(price * quantity + fee) : price * quantity - fee;
    derivedById.set(String(trade.id), { ...trade, symbol, side, qty: quantity, price, fee, positionAfter: newQty, realizedAfter: realized });
  }

  const trades = (Array.isArray(sourceTrades) ? sourceTrades : [])
    .map((trade) => derivedById.get(String(trade.id)) || trade)
    .sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));
  const watchlist = Array.from(new Set([
    ...(Array.isArray(state.watchlist) ? state.watchlist : []),
    ...trades.map((trade) => String(trade.symbol || "").toUpperCase()),
  ].filter(Boolean)));

  return { ...state, cash, positions, trades, watchlist };
}

async function listUserTrades(env, userId, limit = 100000) {
  const safeLimit = Math.max(1, Math.min(100000, Math.trunc(finiteNumber(limit, 1000))));
  const result = await env.DB.prepare("SELECT json FROM ml_user_trades WHERE user_id=? ORDER BY COALESCE(trade_time,created_at) DESC LIMIT ?")
    .bind(userId, safeLimit)
    .all();
  return (result.results || []).map((row) => {
    try { return JSON.parse(row.json); } catch { return null; }
  }).filter(Boolean);
}

async function userTradeCount(env, userId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM ml_user_trades WHERE user_id=?").bind(userId).first();
  return Number(row?.count || 0);
}

async function readUserReviews(env, userId) {
  const result = await env.DB.prepare("SELECT trade_id,json FROM ml_user_trade_reviews WHERE user_id=? ORDER BY updated_at DESC")
    .bind(userId)
    .all();
  const reviews = {};
  for (const row of result.results || []) {
    try { reviews[row.trade_id] = JSON.parse(row.json); } catch {}
  }
  return reviews;
}

async function userReviewCount(env, userId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM ml_user_trade_reviews WHERE user_id=?").bind(userId).first();
  return Number(row?.count || 0);
}

async function readUserState(env, userId) {
  const row = await env.DB.prepare("SELECT json FROM ml_user_state WHERE user_id=?").bind(userId).first();
  let state = {};
  if (row?.json) {
    try { state = JSON.parse(row.json); } catch {}
  }
  const trades = await listUserTrades(env, userId, 100000);
  const rebuilt = rebuildLedgerState(state, trades);
  rebuilt.tradeReviews = await readUserReviews(env, userId);
  return rebuilt;
}

async function writeUserState(env, userId, state) {
  const compact = { ...(state && typeof state === "object" ? state : {}) };
  delete compact.trades;
  delete compact.tradeReviews;
  delete compact.positions;
  delete compact.cash;
  const encoded = JSON.stringify(compact);
  if (encoded.length > MAX_JSON_BYTES) throw new Error("State exceeds 5 MB");
  await env.DB.prepare("INSERT INTO ml_user_state(user_id,json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at")
    .bind(userId, encoded, nowIso())
    .run();
}

async function insertUserTrade(env, user, input) {
  const trade = validateTrade(input);
  trade._createdAt = trade._createdAt || nowIso();
  trade._createdBy = trade._createdBy || user.username;
  const timestamp = nowIso();
  const result = await env.DB.prepare("INSERT OR IGNORE INTO ml_user_trades(user_id,id,trade_time,symbol,side,qty,price,fee,json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .bind(user.id, trade.id, trade.time, trade.symbol, trade.side, trade.qty, trade.price, trade.fee, JSON.stringify(trade), timestamp, timestamp)
    .run();
  if (Number(result.meta?.changes || 0) > 0) {
    await recordTradeAudit(env, user.id, trade.id, "create", null, trade, user.username);
  }
  return { inserted: Number(result.meta?.changes || 0) > 0, trade };
}

async function getUserTrade(env, userId, tradeId) {
  const row = await env.DB.prepare("SELECT json FROM ml_user_trades WHERE user_id=? AND id=?").bind(userId, tradeId).first();
  if (!row) return null;
  try { return JSON.parse(row.json); } catch { return null; }
}

async function recordTradeAudit(env, userId, tradeId, action, beforeValue, afterValue, changedBy) {
  await env.DB.prepare("INSERT INTO ml_trade_audit(id,user_id,trade_id,action,before_json,after_json,changed_by,changed_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), userId, tradeId, action, beforeValue ? JSON.stringify(beforeValue) : null, afterValue ? JSON.stringify(afterValue) : null, changedBy, nowIso())
    .run();
}

async function updateUserTrade(env, user, tradeId, input) {
  const before = await getUserTrade(env, user.id, tradeId);
  if (!before) throw new Error("Trade not found");
  const trade = validateTrade(input, before);
  trade.id = before.id;
  trade._createdAt = before._createdAt || before.time;
  trade._createdBy = before._createdBy || user.username;
  trade._editedAt = nowIso();
  trade._editedBy = user.username;
  await env.DB.prepare("UPDATE ml_user_trades SET trade_time=?,symbol=?,side=?,qty=?,price=?,fee=?,json=?,updated_at=? WHERE user_id=? AND id=?")
    .bind(trade.time, trade.symbol, trade.side, trade.qty, trade.price, trade.fee, JSON.stringify(trade), trade._editedAt, user.id, tradeId)
    .run();
  await env.DB.prepare("DELETE FROM ml_user_trade_reviews WHERE user_id=? AND trade_id=?").bind(user.id, tradeId).run();
  await recordTradeAudit(env, user.id, tradeId, "update", before, trade, user.username);
  return trade;
}

async function listTradeAudit(env, userId, tradeId) {
  const result = await env.DB.prepare("SELECT id,action,before_json,after_json,changed_by,changed_at FROM ml_trade_audit WHERE user_id=? AND trade_id=? ORDER BY changed_at DESC LIMIT 100")
    .bind(userId, tradeId)
    .all();
  return (result.results || []).map((row) => ({
    id: row.id,
    action: row.action,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  }));
}

async function saveUserReview(env, userId, tradeId, review) {
  await env.DB.prepare("INSERT INTO ml_user_trade_reviews(user_id,trade_id,json,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,trade_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at")
    .bind(userId, tradeId, JSON.stringify(review), nowIso())
    .run();
}

async function exportUserData(env, user) {
  const state = await readUserState(env, user.id);
  const trades = await listUserTrades(env, user.id, 100000);
  const reviews = await readUserReviews(env, user.id);
  return {
    format: "marketlab-cloud-user-backup",
    version: 3,
    exportedAt: nowIso(),
    user: { username: user.username, displayName: user.displayName, role: user.role },
    state,
    trades,
    reviews,
  };
}

async function importUserData(env, user, payload) {
  const state = payload.state?.state && typeof payload.state.state === "object"
    ? payload.state.state
    : payload.state && typeof payload.state === "object"
      ? payload.state
      : payload.state === undefined && payload.trades === undefined && payload.reviews === undefined && payload.version
        ? payload
        : null;
  const trades = Array.isArray(payload.trades) ? payload.trades : Array.isArray(state?.trades) ? state.trades : [];
  const reviews = payload.reviews && typeof payload.reviews === "object" && !Array.isArray(payload.reviews) ? payload.reviews : {};
  let importedTrades = 0;
  for (const trade of trades) {
    if ((await insertUserTrade(env, user, trade)).inserted) importedTrades += 1;
  }
  let importedReviews = 0;
  for (const [tradeId, review] of Object.entries(reviews)) {
    if (review && typeof review === "object") {
      await saveUserReview(env, user.id, tradeId, review);
      importedReviews += 1;
    }
  }
  if (state) await writeUserState(env, user.id, state);
  return {
    imported: true,
    importedTrades,
    importedReviews,
    stateImported: Boolean(state),
    totalTrades: await userTradeCount(env, user.id),
  };
}

async function listUsers(env) {
  const result = await env.DB.prepare("SELECT id,username,display_name,role,active,created_at,updated_at FROM ml_users ORDER BY CASE WHEN role='master' THEN 0 ELSE 1 END,username")
    .all();
  const users = [];
  for (const row of result.results || []) {
    users.push({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tradeCount: await userTradeCount(env, row.id),
    });
  }
  return users;
}

async function createUser(env, payload) {
  const username = normalizeUsername(payload.username);
  if (username === "master") throw new Error("The master username is reserved");
  const displayName = String(payload.displayName || username).trim().slice(0, 80) || username;
  if (await getUserByUsername(env, username)) throw new Error("That username already exists");
  const password = await createPasswordRecord(payload.password);
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  try {
    await env.DB.prepare("INSERT INTO ml_users(id,username,display_name,password_salt,password_hash,password_iterations,role,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(id, username, displayName, password.salt, password.hash, password.iterations, "user", 1, timestamp, timestamp)
      .run();
  } catch (error) {
    if (/unique/i.test(String(error.message || error))) throw new Error("That username already exists");
    throw error;
  }
  return publicUser(await getUserById(env, id));
}

async function resetUserPassword(env, userId, password) {
  if (userId === MASTER_USER_ID) throw new Error("Change the master password through the MARKETLAB_PASSWORD Cloudflare secret");
  const record = await createPasswordRecord(password);
  const result = await env.DB.prepare("UPDATE ml_users SET password_salt=?,password_hash=?,password_iterations=?,updated_at=? WHERE id=?")
    .bind(record.salt, record.hash, record.iterations, nowIso(), userId)
    .run();
  if (!Number(result.meta?.changes || 0)) throw new Error("User not found");
}

async function setUserStatus(env, userId, active) {
  if (userId === MASTER_USER_ID) throw new Error("The master user cannot be disabled");
  const result = await env.DB.prepare("UPDATE ml_users SET active=?,updated_at=? WHERE id=?")
    .bind(active ? 1 : 0, nowIso(), userId)
    .run();
  if (!Number(result.meta?.changes || 0)) throw new Error("User not found");
}

async function createLegacySession(env) {
  const payload = JSON.stringify({ exp: epochSeconds() + SESSION_TTL_SECONDS, nonce: crypto.randomUUID() });
  const encoded = stringToBase64Url(payload);
  const secret = env.SESSION_SECRET || `${env.MARKETLAB_PASSWORD}:marketlab-session`;
  return `${encoded}.${await signText(encoded, secret)}`;
}

async function legacyRequest(request, env, bodyText) {
  const headers = new Headers(request.headers);
  const cookies = parseCookies(request);
  cookies.ml_session = await createLegacySession(env);
  headers.set("Cookie", Object.entries(cookies).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("; "));
  const init = { method: request.method, headers, redirect: "manual" };
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) {
    init.body = bodyText !== undefined ? bodyText : await request.clone().text();
  }
  return legacyWorkerFetch(new Request(request.url, init), env);
}

async function mergedHealth(request, env, user) {
  const legacy = await legacyRequest(request, env);
  let health = {};
  try { health = await legacy.json(); } catch {}
  return {
    ...health,
    status: "ok",
    version: env.APP_VERSION || APP_VERSION,
    multiUser: true,
    user,
    tradeCount: await userTradeCount(env, user.id),
    tradeReviewCount: await userReviewCount(env, user.id),
    tradeDatabase: "Cloudflare D1 · isolated by user",
  };
}

function requireMaster(user) {
  if (user.role !== "master") throw new Error("Master access is required");
}

async function handleScopedApi(request, env, url, user) {
  const method = request.method.toUpperCase();

  if (url.pathname === "/api/health" && method === "GET") return jsonResponse(await mergedHealth(request, env, user));
  if (url.pathname === "/api/users/me" && method === "GET") return jsonResponse({ user });

  if (url.pathname === "/api/state" && method === "GET") return jsonResponse({ state: await readUserState(env, user.id) });
  if (url.pathname === "/api/state" && method === "POST") {
    await writeUserState(env, user.id, await readJsonBody(request));
    return jsonResponse({ saved: true, savedAt: nowIso(), tradeCount: await userTradeCount(env, user.id) });
  }

  if (url.pathname === "/api/trades" && method === "GET") {
    const trades = await listUserTrades(env, user.id, url.searchParams.get("limit") || 1000);
    return jsonResponse({ trades, count: trades.length, database: "Cloudflare D1 · user scoped" });
  }
  if (url.pathname === "/api/trades" && method === "POST") {
    const saved = await insertUserTrade(env, user, await readJsonBody(request));
    return jsonResponse({ saved: true, inserted: saved.inserted, trade: saved.trade, tradeCount: await userTradeCount(env, user.id), savedAt: nowIso() });
  }

  const tradeMatch = url.pathname.match(/^\/api\/trades\/([^/]+)$/);
  if (tradeMatch && method === "PUT") {
    const tradeId = decodeURIComponent(tradeMatch[1]);
    const trade = await updateUserTrade(env, user, tradeId, await readJsonBody(request));
    return jsonResponse({ saved: true, trade, tradeCount: await userTradeCount(env, user.id), savedAt: nowIso() });
  }
  const auditMatch = url.pathname.match(/^\/api\/trades\/([^/]+)\/audit$/);
  if (auditMatch && method === "GET") {
    return jsonResponse({ audit: await listTradeAudit(env, user.id, decodeURIComponent(auditMatch[1])) });
  }

  if (url.pathname === "/api/trade-reviews" && method === "GET") {
    const reviews = await readUserReviews(env, user.id);
    return jsonResponse({ reviews, count: Object.keys(reviews).length, database: "Cloudflare D1 · user scoped" });
  }

  if (url.pathname === "/api/ai/suggestions" && method === "POST") {
    const payload = await readJsonBody(request);
    payload.state = await readUserState(env, user.id);
    const delegated = await legacyRequest(request, env, JSON.stringify(payload));
    const result = await delegated.json();
    return jsonResponse(result, delegated.status);
  }

  if (url.pathname === "/api/ai/trade-review" && method === "POST") {
    const payload = await readJsonBody(request);
    const delegated = await legacyRequest(request, env, JSON.stringify(payload));
    const review = await delegated.json();
    if (!delegated.ok) return jsonResponse(review, delegated.status);
    const tradeId = String(review.tradeId || payload.trade?.id || payload.result?.id || "");
    if (tradeId) await saveUserReview(env, user.id, tradeId, review);
    return jsonResponse(review);
  }

  if (url.pathname === "/api/export" && method === "GET") {
    const backup = await exportUserData(env, user);
    return new Response(JSON.stringify(backup, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="marketlab-${user.username}-backup-${new Date().toISOString().slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      },
    });
  }
  if (url.pathname === "/api/import" && method === "POST") return jsonResponse(await importUserData(env, user, await readJsonBody(request)));
  if (url.pathname === "/api/backup" && method === "POST") {
    const backup = await exportUserData(env, user);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO ml_user_backups(id,user_id,json,created_at) VALUES(?,?,?,?)")
      .bind(id, user.id, JSON.stringify(backup), nowIso())
      .run();
    return jsonResponse({ saved: true, backupId: id, createdAt: backup.exportedAt, files: ["D1 user backup snapshot"] });
  }

  if (url.pathname === "/api/users" && method === "GET") {
    requireMaster(user);
    return jsonResponse({ users: await listUsers(env) });
  }
  if (url.pathname === "/api/users" && method === "POST") {
    requireMaster(user);
    return jsonResponse({ created: true, user: await createUser(env, await readJsonBody(request)) }, 201);
  }
  const passwordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/);
  if (passwordMatch && method === "PUT") {
    requireMaster(user);
    const payload = await readJsonBody(request);
    await resetUserPassword(env, decodeURIComponent(passwordMatch[1]), payload.password);
    return jsonResponse({ saved: true });
  }
  const statusMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/status$/);
  if (statusMatch && method === "PUT") {
    requireMaster(user);
    const payload = await readJsonBody(request);
    await setUserStatus(env, decodeURIComponent(statusMatch[1]), Boolean(payload.active));
    return jsonResponse({ saved: true });
  }

  return legacyRequest(request, env);
}

async function serveAsset(request, env, authenticated) {
  const url = new URL(request.url);
  const response = await env.ASSETS.fetch(request);
  const contentType = response.headers.get("Content-Type") || "";
  if (!authenticated || !contentType.includes("text/html")) return securedResponse(response, contentType.includes("text/html"));

  let html = await response.text();
  if (!html.includes("/multiuser.css")) html = html.replace("</head>", '<link rel="stylesheet" href="/multiuser.css"></head>');
  if (!html.includes("/multiuser.js")) html = html.replace("</body>", '<script src="/multiuser.js"></script></body>');
  return htmlResponse(html, response.status);
}

async function fetchHandler(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return jsonResponse({ status: "ok", service: "marketlab-cloud", version: env.APP_VERSION || APP_VERSION, multiUser: true });
  if ([
    "/manifest.webmanifest",
    "/service-worker.js",
    "/icon.svg",
    "/icon-192.png",
    "/icon-512.png",
    "/history.js",
    "/trading.js",
    "/performance.js",
    "/insights.js",
    "/multiuser.js",
    "/multiuser.css",
  ].includes(url.pathname)) {
    return serveAsset(request, env, false);
  }

  try {
    await ensureMultiUserSchema(env);
  } catch (error) {
    console.error("Multi-user schema initialization failed", error);
    const message = String(error?.message || error);
    if (url.pathname.startsWith("/api/")) return jsonResponse({ error: message }, 503);
    return htmlResponse(`<h1>MarketLab database setup error</h1><p>${htmlEscape(message)}</p>`, 503);
  }

  if (url.pathname === "/auth/login" && request.method === "POST") {
    const form = await request.formData();
    const username = String(form.get("username") || "master");
    const password = String(form.get("password") || "");
    let user;
    try { user = await authenticateLogin(env, username, password); } catch {}
    if (!user) return htmlResponse(loginPage("Incorrect username or password.", username), 401);
    const headers = new Headers({ Location: "/" });
    headers.append("Set-Cookie", userSessionCookie(await createUserSession(env, user)));
    headers.append("Set-Cookie", clearCookie("ml_session"));
    return new Response(null, { status: 303, headers });
  }

  if (url.pathname === "/logout" || url.pathname === "/auth/logout") {
    const headers = new Headers({ Location: "/login" });
    headers.append("Set-Cookie", clearCookie(USER_SESSION_COOKIE));
    headers.append("Set-Cookie", clearCookie("ml_session"));
    return new Response(null, { status: 303, headers });
  }

  const user = await verifyUserSession(request, env);
  if (!user) {
    if (url.pathname.startsWith("/api/")) return jsonResponse({ error: "Authentication required" }, 401);
    if (["/multiuser.js", "/multiuser.css"].includes(url.pathname)) return serveAsset(request, env, false);
    return htmlResponse(loginPage("", "master"));
  }

  try {
    if (url.pathname.startsWith("/api/")) return await handleScopedApi(request, env, url, user);
    if (url.pathname === "/login") return new Response(null, { status: 303, headers: { Location: "/", ...SECURITY_HEADERS } });
    if (url.pathname === "/import") return legacyRequest(request, env);
    return serveAsset(request, env, true);
  } catch (error) {
    console.error(error);
    const message = String(error.message || error);
    if (url.pathname.startsWith("/api/")) {
      const status = /master access/i.test(message) ? 403 : /not found/i.test(message) ? 404 : /required|invalid|must|positive|username|password|reserved/i.test(message) ? 400 : 502;
      return jsonResponse({ error: message }, status);
    }
    return htmlResponse(`<h1>MarketLab error</h1><p>${htmlEscape(message)}</p>`, 500);
  }
}

export {
  createPasswordRecord,
  derivePasswordHash,
  normalizeUsername,
  rebuildLedgerState,
  validateTrade,
};

export default { fetch: fetchHandler };
