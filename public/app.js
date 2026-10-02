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
    s = a.snapshot,
    needs = a.error || low(a) || stale(a);
  const status = a.error
    ? "Refresh failed"
    : low(a)
      ? "Threshold reached"
      : stale(a)
        ? "Outdated"
        : p.refreshing
          ? "Refreshing…"
          : s
            ? age(s.updatedAt)
            : "Awaiting balance";
  return `<article class="card account-row ${needs ? "alert" : ""}">
    <div class="provider-cell"><span class="icon icon-${p.id}">${esc(p.initial)}</span><div><h3>${esc(p.name)}</h3><span class="source">${p.id === "higgsfield" ? "API wallet" : a.mode === "api" ? "API" : "Browser"}</span></div></div>
    <div class="balance-cell"><div class="amount">${s ? money(s) : "—"}</div><div class="metric">${esc(s?.label || "Balance")}</div></div>
    <div class="status-cell"><span class="status ${needs ? "status-warning" : ""}"><span class="dot ${needs ? "" : "live"}"></span>${esc(status)}</span>${a.error ? `<p class="card-message">${esc(a.error)}</p>` : !s && a.mode === "browser" ? '<p class="card-message">Select a balance with the extension.</p>' : ""}</div>
    <div class="row-actions"><a class="icon-button" href="${esc(a.config.url || p.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${p.name} billing" title="Open billing">↗</a><button class="icon-button" data-refresh="${p.id}" aria-label="Refresh ${p.name}" title="Refresh" ${p.refreshing ? "disabled" : ""}>↻</button><button class="icon-button" data-manage="${p.id}" aria-label="Manage ${p.name}" title="Manage">···</button></div>
  </article>`;
}
function render() {
  const connected = state.providers.filter((p) => p.account),
    attention = connected.filter(
      (p) => p.account.error || low(p.account) || stale(p.account),
    );
  $("#accounts").innerHTML = connected.length
    ? connected.map(card).join("")
    : '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">＋</span><h3>No accounts connected</h3><button class="quiet" data-add>Add account</button></div>';
  $("#connected").textContent = connected.length;
  $("#attention").textContent = attention.length;
  $("#attention-widget").hidden = !attention.length;
  $("#provider-list").innerHTML =
    state.providers
      .filter((p) => !p.account)
      .map(
        (p) =>
          `<button class="provider-option" data-manage="${p.id}" aria-label="Connect ${p.name}"><span class="icon icon-${p.id}">${esc(p.initial)}</span><span>${esc(p.name)}</span><span class="option-plus" aria-hidden="true">+</span></button>`,
      )
      .join("") || "<p>All available providers are connected.</p>";
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
      `<p>${selected.id === "openrouter" ? "Reads your credit balance." : selected.id === "railway" ? "Reads usage and estimated billing." : "Tracks spend. Use Browser balance for wallet credits."}</p><label class="field">${esc(selected.apiLabel)}<input name="secret" type="password" autocomplete="off" ${selected.id === "railway" ? "" : "required"}></label>${["railway", "vercel"].includes(selected.id) ? `<label class="field">${selected.id === "railway" ? "Workspace" : "Team"} ID<input name="scope" required value="${esc(a?.config.scope || "")}" placeholder="${selected.id === "railway" ? "Your workspace ID" : "team_…"}"></label>` : ""}${selected.id === "railway" ? "<small>Leave the token empty to use your existing Railway CLI login.</small>" : ""}`;
  } else {
    $("#fields").innerHTML =
      `<p><button class="quiet" type="button" id="setup-extension">Set up extension</button></p><label class="field">Billing page URL<input name="url" type="url" required value="${esc(a?.config.url || selected.url)}"><small>Use your account’s billing URL.</small></label><label class="field">What are you tracking?<select name="kind"><option value="balance">Remaining wallet balance</option><option value="spend">Spend this billing period</option><option value="allowance">Remaining included allowance</option></select></label><label class="field">Unit<select name="unit"><option>USD</option><option>credits</option><option>EUR</option><option>GBP</option></select></label><p class="note">After connecting, choose Select balance in the extension.</p>`;
    $("[name=kind]").value = a?.config.kind || selected.metric;
    $("[name=unit]").value = a?.config.unit || "USD";
  }
}
function openConnect(id) {
  $("#add-dialog").close();
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
    if (b.hasAttribute("data-add")) $("#add-dialog").showModal();
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
$("#add-account").onclick = () => $("#add-dialog").showModal();
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
