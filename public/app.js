const $ = (s) => document.querySelector(s);
let state,
  selected,
  mode = "api",
  toastTimer;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Tracker-CSRF": state.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Request failed.");
  return data;
}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 5000);
}
function age(date) {
  const mins = Math.floor((Date.now() - Date.parse(date)) / 60000);
  return mins < 1
    ? "Just updated"
    : mins < 60
      ? `${mins}m ago`
      : mins < 1440
        ? `${Math.floor(mins / 60)}h ago`
        : `${Math.floor(mins / 1440)}d ago`;
}
function stale(a) {
  return (
    a?.snapshot &&
    Date.now() - Date.parse(a.snapshot.updatedAt) >
      Math.max(120, (state.interval || 60) * 2) * 60000
  );
}
function low(a) {
  return (
    a?.snapshot &&
    a.threshold != null &&
    (a.snapshot.kind === "spend"
      ? Number(a.snapshot.value) > a.threshold
      : Number(a.snapshot.value) < a.threshold)
  );
}
function money(s) {
  return s.unit === "credits"
    ? `${Number(s.value).toLocaleString(undefined, { maximumFractionDigits: 4 })} <small>credits</small>`
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: s.unit,
        maximumFractionDigits: 2,
      }).format(Number(s.value));
}
function card(p) {
  const a = p.account,
    s = a?.snapshot,
    needs = a?.error || low(a) || stale(a);
  return `<article class="card ${needs ? "alert" : ""}"><div class="card-top"><span class="icon">${esc(p.initial)}</span><div><h3>${esc(p.name)}</h3><div class="source">${p.id === "higgsfield" ? "API wallet" : a ? `${a.mode === "api" ? "API" : "Browser"} connection` : "Not connected"}</div></div>${a ? `<button class="manage" data-manage="${p.id}" aria-label="Manage ${p.name}">···</button>` : ""}</div>${s ? `<div class="amount">${money(s)}</div><p class="metric">${esc(s.label)}${low(a) ? '<span class="tag">Check balance</span>' : ""}</p><p class="detail">${esc(s.detail)}</p>` : `<div class="empty-value">—</div><p class="card-description">${a ? (p.refreshing ? "Fetching your latest numbers…" : a.mode === "browser" ? "Open billing and select the balance with the extension." : "Waiting for the first successful refresh.") : p.category === "AI wallets" ? "Keep an eye on your remaining credits." : "Keep your cloud costs within reach."}</p>`}${a?.error ? `<p class="card-message">${esc(a.error)}</p>` : stale(a) ? '<p class="card-message">This value is older than expected. Refresh to check it.</p>' : ""}<div class="card-bottom">${a ? `<span>${p.refreshing ? "Refreshing…" : s ? esc(age(s.updatedAt)) : "Not yet synced"}</span><a href="${esc(a.config.url || p.url)}" target="_blank" rel="noopener noreferrer">Open billing ↗</a><button class="refresh-icon" data-refresh="${p.id}" aria-label="Refresh ${p.name}" ${p.refreshing ? "disabled" : ""}>↻</button>` : `<span>${p.api ? "API or browser" : "Browser connection"}</span><button class="quiet" data-manage="${p.id}">Connect ${p.name}</button>`}</div></article>`;
}
function render() {
  $("#accounts").innerHTML = ["AI wallets", "Cloud services"]
    .map(
      (category) =>
        `<section><div class="section-title"><h2>${category}</h2><span class="rule"></span></div><div class="cards">${state.providers
          .filter((p) => p.category === category)
          .map(card)
          .join("")}</div></section>`,
    )
    .join("");
  const connected = state.providers.filter((p) => p.account),
    wallets = connected.filter(
      (p) =>
        p.account.snapshot?.kind === "balance" &&
        p.account.snapshot.unit === "USD",
    ),
    attention = connected.filter(
      (p) => p.account.error || low(p.account) || stale(p.account),
    );
  $("#total").textContent = wallets.length
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
      }).format(
        wallets.reduce((sum, p) => sum + Number(p.account.snapshot.value), 0),
      )
    : "—";
  $("#total-note").textContent = wallets.length
    ? `${wallets.length} USD wallet${wallets.length === 1 ? "" : "s"} · last reported balances${wallets.some((p) => stale(p.account) || p.account.error) ? " · includes stale values" : ""}`
    : "Connect a wallet to see your balance.";
  $("#connected").innerHTML = `${connected.length} <span>/ 6 providers</span>`;
  $("#attention").innerHTML = `${attention.length} <span>accounts</span>`;
  $("#account-summary").textContent = connected.length
    ? "A balance is what’s left. Usage is what’s been spent."
    : "Start with the tools you use.";
  $("#interval").value = state.interval;
  $("#bridge-dot").classList.toggle("live", state.bridgeConnected);
  $("#refresh-all").disabled =
    !connected.length || state.providers.some((p) => p.refreshing);
}
async function load() {
  try {
    state = await api("state");
    render();
  } catch (e) {
    toast("Dashboard unavailable. Keep the app running and reload.");
  }
}
function fields() {
  $("#method-tabs").innerHTML = (
    selected.api ? ["api", "browser"] : ["browser"]
  )
    .map(
      (m) =>
        `<button type="button" data-mode="${m}" class="${mode === m ? "active" : ""}">${m === "api" ? "API connection" : "Browser balance"}</button>`,
    )
    .join("");
  const a = selected.account;
  if (mode === "api") {
    $("#fields").innerHTML =
      `<p>${selected.id === "openrouter" ? "Connect a management key to read your remaining credit balance." : selected.id === "railway" ? "Read current usage and estimated billing with your Railway account." : "This connection shows spend. Choose Browser balance to track remaining wallet credits instead."}</p><label class="field">${esc(selected.apiLabel)}<input name="secret" type="password" autocomplete="off" ${selected.id === "railway" ? "" : "required"}><small>Encrypted on this computer. Never sent to our servers.</small></label>${["railway", "vercel"].includes(selected.id) ? `<label class="field">${selected.id === "railway" ? "Workspace" : "Team"} ID<input name="scope" required value="${esc(a?.config.scope || "")}" placeholder="${selected.id === "railway" ? "Your workspace ID" : "team_…"}"></label>` : ""}${selected.id === "railway" ? "<small>Leave the token empty to use your existing Railway CLI login.</small>" : ""}`;
  } else {
    $("#fields").innerHTML =
      `<p>Read the balance directly from your signed-in billing page. <button class="quiet" type="button" id="setup-extension">Set up extension</button></p><label class="field">Billing page URL<input name="url" type="url" required value="${esc(a?.config.url || selected.url)}"><small>Use the page for the exact account or workspace you want to track.</small></label><label class="field">What are you tracking?<select name="kind"><option value="balance">Remaining wallet balance</option><option value="spend">Spend this billing period</option><option value="allowance">Remaining included allowance</option></select></label><label class="field">Unit<select name="unit"><option>USD</option><option>credits</option><option>EUR</option><option>GBP</option></select></label><p class="note">After connecting, open your billing page and click Select balance in the extension. You’ll confirm the exact number before it is saved.</p>`;
    $("[name=kind]").value = a?.config.kind || selected.metric;
    $("[name=unit]").value = a?.config.unit || "USD";
  }
}
function openConnect(id) {
  selected = state.providers.find((p) => p.id === id);
  mode =
    selected.account?.mode ||
    (selected.id === "openrouter" || selected.id === "railway"
      ? "api"
      : "browser");
  $("#connect-title").textContent = selected.name;
  $("#connect-form [name=provider]").value = id;
  $("#connect-form [name=threshold]").value = selected.account?.threshold ?? "";
  $("#disconnect").hidden = !selected.account;
  $("#form-error").textContent = "";
  fields();
  $("#connect-dialog").showModal();
}
function showExtension() {
  $("#extension-dialog").showModal();
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.hasAttribute("data-close")) b.closest("dialog").close();
    if (b.dataset.manage) openConnect(b.dataset.manage);
    if (b.dataset.mode) {
      mode = b.dataset.mode;
      fields();
    }
    if (b.dataset.refresh) {
      await api("refresh", { provider: b.dataset.refresh });
      await load();
    }
    if (b.id === "setup-extension") showExtension();
  } catch (err) {
    toast(err.message);
  }
});
$("#connect-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = $("#save-connection");
  b.disabled = true;
  $("#form-error").textContent = "";
  try {
    await api("connect", {
      ...Object.fromEntries(new FormData(e.target)),
      mode,
    });
    $("#connect-dialog").close();
    await load();
    toast(
      mode === "browser"
        ? "Connected. Select the balance from your billing page with the extension."
        : "Connected. Fetching your latest numbers.",
    );
  } catch (err) {
    $("#form-error").textContent = err.message;
  } finally {
    b.disabled = false;
  }
});
$("#disconnect").onclick = async () => {
  if (
    !confirm(
      `Disconnect ${selected.name}? Its stored key and balance will be removed.`,
    )
  )
    return;
  try {
    await api("disconnect", { provider: selected.id });
    $("#connect-dialog").close();
    await load();
    toast("Account disconnected.");
  } catch (e) {
    toast(e.message);
  }
};
$("#refresh-all").onclick = async () => {
  try {
    await api("refresh", {});
    await load();
    toast("Refreshing connected accounts.");
  } catch (e) {
    toast(e.message);
  }
};
$("#interval").onchange = async (e) => {
  try {
    await api("settings", { interval: Number(e.target.value) });
    await load();
    toast("Refresh schedule saved.");
  } catch (e) {
    toast(e.message);
  }
};
$("#extension-button").onclick = showExtension;
$("#pair").onclick = async () => {
  try {
    const result = await api("pair", {});
    $("#pairing-box").hidden = false;
    $("#pair-code").value = result.code;
    $("#pair-code").select();
  } catch (e) {
    toast(e.message);
  }
};
$("#unpair").onclick = async () => {
  try {
    await api("unpair", {});
    await load();
    toast("Extension unpaired.");
  } catch (e) {
    toast(e.message);
  }
};
await load();
setInterval(load, 4000);
