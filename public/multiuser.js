(() => {
  "use strict";

  const VERSION = "2.2.1";
  let currentUser = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function insertBeforeLastClosingDiv(html, fragment) {
    const index = html.lastIndexOf("</div>");
    return index >= 0 ? `${html.slice(0, index)}${fragment}${html.slice(index)}` : `${html}${fragment}`;
  }

  function modal(title, body, options = {}) {
    document.querySelector("#mlUserModal")?.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="mlUserModal" class="ml-modal-backdrop"><section class="ml-modal" role="dialog" aria-modal="true"><div class="ml-modal-head"><div><div class="eyebrow">MarketLab users</div><h2>${escapeHtml(title)}</h2></div><button type="button" class="ml-modal-close" aria-label="Close">×</button></div><div class="ml-modal-body">${body}</div></section></div>`,
    );
    const overlay = document.querySelector("#mlUserModal");
    overlay.querySelector(".ml-modal-close").onclick = () => overlay.remove();
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay && options.locked !== true) overlay.remove();
    });
    return overlay;
  }

  function userCardHtml() {
    const user = currentUser || backendHealth?.user;
    if (!user) return "";
    return `<section class="card ml-account-card"><div class="row"><div><div class="eyebrow">Signed-in portfolio</div><h2>${escapeHtml(user.displayName || user.username)}</h2><p class="muted">Username <b>${escapeHtml(user.username)}</b> · ${escapeHtml(user.role)} · trades and saved state are isolated from every other user.</p></div><span class="ml-role-badge ${user.role === "master" ? "master" : ""}">${escapeHtml(user.role)}</span></div>${user.role === "master" ? '<button id="mlManageUsers" class="btn secondary">Manage users</button>' : '<div class="learning-note">Ask the master user to reset your password or change account status.</div>'}</section>`;
  }

  function decorateHeader() {
    const user = currentUser || backendHealth?.user;
    if (!user) return;
    const sub = document.querySelector(".sub");
    if (sub) sub.textContent = `Private cloud paper trading lab · v${VERSION}`;
    const actions = document.querySelector(".header-actions");
    if (!actions) return;
    let badge = document.querySelector("#mlUserBadge");
    if (!badge) {
      badge = document.createElement("button");
      badge.id = "mlUserBadge";
      badge.type = "button";
      badge.className = "learn-button ml-user-badge";
      const logout = actions.querySelector('a[href="/logout"]');
      actions.insertBefore(badge, logout || actions.firstChild);
    }
    badge.textContent = `${user.displayName || user.username} · ${user.role}`;
    badge.onclick = () => {
      modal(
        "Current user",
        `<div class="ml-current-user"><strong>${escapeHtml(user.displayName || user.username)}</strong><span>@${escapeHtml(user.username)}</span><span>${escapeHtml(user.role)} account</span><span>${Number(backendHealth?.tradeCount || 0)} trades</span></div><a class="btn secondary ml-block-link" href="/logout">Log out</a>`,
      );
    };
  }

  async function reloadScopedState() {
    const [saved, reviews] = await Promise.all([
      api("/api/state"),
      api("/api/trade-reviews").catch(() => ({ reviews: {} })),
    ]);
    state = MarketLabTrading.migrateState(saved.state || {}, fresh());
    state.tradeReviews = { ...(state.tradeReviews || {}), ...(reviews.reviews || {}) };
    backendHealth.tradeCount = Array.isArray(state.trades) ? state.trades.length : 0;
    save();
    render();
  }

  function tradeEditorHtml(trade) {
    const journal = trade.journal || {};
    const dateValue = (() => {
      try {
        const date = new Date(trade.time);
        const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 16);
      } catch {
        return "";
      }
    })();
    return `<form id="mlTradeEditForm" class="ml-form"><div class="ml-grid"><div class="field"><label>Symbol</label><input id="mlEditSymbol" value="${escapeHtml(trade.symbol)}" autocapitalize="characters" required></div><div class="field"><label>Side</label><select id="mlEditSide"><option value="buy" ${trade.side !== "sell" ? "selected" : ""}>Buy</option><option value="sell" ${trade.side === "sell" ? "selected" : ""}>Sell / short</option></select></div><div class="field"><label>Quantity / amount</label><input id="mlEditQty" inputmode="decimal" value="${escapeHtml(trade.qty)}" required></div><div class="field"><label>Execution price</label><input id="mlEditPrice" inputmode="decimal" value="${escapeHtml(trade.price)}" required></div><div class="field"><label>Fee</label><input id="mlEditFee" inputmode="decimal" value="${escapeHtml(trade.fee || 0)}"></div><div class="field"><label>Date and time</label><input id="mlEditTime" type="datetime-local" value="${escapeHtml(dateValue)}" required></div><div class="field ml-wide"><label>Trade thesis</label><textarea id="mlEditThesis" rows="3">${escapeHtml(journal.thesis || "")}</textarea></div><div class="field ml-wide"><label>Notes / evidence</label><textarea id="mlEditNotes" rows="3">${escapeHtml(journal.notes || "")}</textarea></div></div><div class="ml-edit-warning">Changing an older trade recalculates cash, positions, P/L, and performance from the complete trade ledger. The previous version remains in the audit history.</div><div class="ml-actions"><button class="btn" type="submit">Save trade changes</button><button id="mlViewAudit" class="btn secondary" type="button">View edit history</button></div><pre id="mlTradeEditResult" class="ml-result"></pre></form>`;
  }

  async function openTradeEditor(tradeId) {
    const trade = (state.trades || []).find((item) => String(item.id) === String(tradeId));
    if (!trade) return message("Trade not found in the current user portfolio.");
    const overlay = modal(`Edit ${trade.symbol} trade`, tradeEditorHtml(trade));
    const result = overlay.querySelector("#mlTradeEditResult");
    overlay.querySelector("#mlTradeEditForm").onsubmit = async (event) => {
      event.preventDefault();
      const button = event.submitter;
      if (button) button.disabled = true;
      result.textContent = "Saving and rebuilding the portfolio…";
      try {
        const localDate = new Date(overlay.querySelector("#mlEditTime").value);
        const journal = {
          ...(trade.journal || {}),
          thesis: overlay.querySelector("#mlEditThesis").value.trim(),
          notes: overlay.querySelector("#mlEditNotes").value.trim(),
        };
        await api(`/api/trades/${encodeURIComponent(trade.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trade: {
              symbol: overlay.querySelector("#mlEditSymbol").value.trim().toUpperCase(),
              side: overlay.querySelector("#mlEditSide").value,
              qty: Number(overlay.querySelector("#mlEditQty").value),
              price: Number(overlay.querySelector("#mlEditPrice").value),
              fee: Number(overlay.querySelector("#mlEditFee").value || 0),
              time: localDate.toISOString(),
              journal,
            },
          }),
        });
        await reloadScopedState();
        overlay.remove();
        message(`${trade.symbol} trade updated. Cash, positions, P/L, and performance were recalculated.`);
      } catch (error) {
        result.textContent = String(error.message || error);
      } finally {
        if (button) button.disabled = false;
      }
    };
    overlay.querySelector("#mlViewAudit").onclick = () => openTradeAudit(trade.id);
  }

  function summarizeTrade(trade) {
    if (!trade) return "—";
    return `${trade.side === "sell" ? "SELL" : "BUY"} ${trade.qty} ${trade.symbol} at ${money(trade.price)} · ${new Date(trade.time).toLocaleString()}`;
  }

  async function openTradeAudit(tradeId) {
    try {
      const data = await api(`/api/trades/${encodeURIComponent(tradeId)}/audit`);
      const rows = (data.audit || []).map((entry) => `<div class="ml-audit-row"><div><strong>${escapeHtml(entry.action.toUpperCase())}</strong><span>${new Date(entry.changedAt).toLocaleString()} · ${escapeHtml(entry.changedBy)}</span></div><small>Before: ${escapeHtml(summarizeTrade(entry.before))}</small><small>After: ${escapeHtml(summarizeTrade(entry.after))}</small></div>`).join("");
      modal("Trade edit history", rows || '<div class="empty">No audit entries are available.</div>');
    } catch (error) {
      message(String(error.message || error));
    }
  }

  function userManagerHtml() {
    return `<div class="ml-user-create"><h3>Create user</h3><div class="ml-grid"><div class="field"><label>Username</label><input id="mlNewUsername" autocapitalize="none" placeholder="e.g. naor2"></div><div class="field"><label>Display name</label><input id="mlNewDisplayName" placeholder="Name shown in MarketLab"></div><div class="field ml-wide"><label>Temporary password</label><input id="mlNewPassword" type="password" autocomplete="new-password" minlength="8"></div></div><button id="mlCreateUser" class="btn">Create separate portfolio</button><pre id="mlUserResult" class="ml-result"></pre></div><div class="ml-users-list"><div class="empty">Loading users…</div></div>`;
  }

  async function openUserManager() {
    const overlay = modal("Manage users", userManagerHtml());
    overlay.querySelector("#mlCreateUser").onclick = async () => {
      const result = overlay.querySelector("#mlUserResult");
      result.textContent = "Creating user…";
      try {
        await api("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: overlay.querySelector("#mlNewUsername").value,
            displayName: overlay.querySelector("#mlNewDisplayName").value,
            password: overlay.querySelector("#mlNewPassword").value,
          }),
        });
        result.textContent = "User created. Their portfolio starts empty.";
        overlay.querySelector("#mlNewUsername").value = "";
        overlay.querySelector("#mlNewDisplayName").value = "";
        overlay.querySelector("#mlNewPassword").value = "";
        await loadUsersInto(overlay);
      } catch (error) {
        result.textContent = String(error.message || error);
      }
    };
    await loadUsersInto(overlay);
  }

  async function loadUsersInto(overlay) {
    const target = overlay.querySelector(".ml-users-list");
    try {
      const data = await api("/api/users");
      target.innerHTML = `<h3>Accounts</h3>${(data.users || []).map((user) => `<article class="ml-user-row"><div class="ml-user-row-main"><strong>${escapeHtml(user.displayName || user.username)}</strong><span>@${escapeHtml(user.username)} · ${escapeHtml(user.role)} · ${Number(user.tradeCount || 0)} trades</span><span>${user.active ? "Active" : "Disabled"}</span></div><div class="ml-user-row-actions">${user.role === "master" ? '<span class="ml-role-badge master">Master</span>' : `<button class="mini-btn" data-reset-user="${escapeHtml(user.id)}">Reset password</button><button class="mini-btn ${user.active ? "danger" : "positive"}" data-toggle-user="${escapeHtml(user.id)}" data-active="${user.active ? "0" : "1"}">${user.active ? "Disable" : "Enable"}</button>`}</div></article>`).join("")}`;
      target.querySelectorAll("[data-reset-user]").forEach((button) => {
        button.onclick = async () => {
          const password = prompt("Enter a new password with at least 8 characters:");
          if (!password) return;
          try {
            await api(`/api/users/${encodeURIComponent(button.dataset.resetUser)}/password`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ password }),
            });
            message("User password reset.");
          } catch (error) {
            message(String(error.message || error));
          }
        };
      });
      target.querySelectorAll("[data-toggle-user]").forEach((button) => {
        button.onclick = async () => {
          try {
            await api(`/api/users/${encodeURIComponent(button.dataset.toggleUser)}/status`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ active: button.dataset.active === "1" }),
            });
            await loadUsersInto(overlay);
          } catch (error) {
            message(String(error.message || error));
          }
        };
      });
    } catch (error) {
      target.innerHTML = `<div class="warning">${escapeHtml(error.message || error)}</div>`;
    }
  }

  const originalSettings = settings;
  settings = function marketLabMultiUserSettings() {
    return insertBeforeLastClosingDiv(originalSettings(), userCardHtml());
  };

  const originalTradeResultRow = tradeResultRow;
  tradeResultRow = function marketLabEditableTradeRow(trade) {
    let html = originalTradeResultRow(trade);
    const edited = trade._editedAt
      ? `<span class="ml-edited-badge">Edited ${new Date(trade._editedAt).toLocaleString()}</span>`
      : "";
    const controls = `<div class="ml-trade-controls"><button type="button" class="mini-btn" data-edit-trade="${escapeHtml(trade.id)}">Edit trade</button>${edited}</div>`;
    html = html.replace('</div><div class="trade-result">', `${controls}</div><div class="trade-result">`);
    return html;
  };

  const originalBind = bind;
  bind = function marketLabMultiUserBind() {
    originalBind();
    document.querySelector("#mlManageUsers")?.addEventListener("click", openUserManager);
    document.querySelectorAll("[data-edit-trade]").forEach((button) => {
      button.addEventListener("click", () => openTradeEditor(button.dataset.editTrade));
    });
  };

  const originalRender = render;
  render = function marketLabMultiUserRender() {
    originalRender();
    currentUser = backendHealth?.user || currentUser;
    decorateHeader();
  };

  const waitForHealth = setInterval(() => {
    if (backendHealth?.user) {
      currentUser = backendHealth.user;
      decorateHeader();
      clearInterval(waitForHealth);
    }
  }, 100);
  setTimeout(() => clearInterval(waitForHealth), 15000);
})();
