const link = (url, text) =>
  `<a href="${url}" target="_blank" rel="noopener noreferrer">${text} ↗</a>`;

const guides = {
  openrouter: {
    steps: [
      `Open ${link("https://openrouter.ai/settings/management-keys", "OpenRouter management keys")} and sign in.`,
      "Choose <strong>Create New Key</strong>, name it <strong>Stash</strong>, and choose an expiration.",
      "Copy the key, paste it below, then click <strong>Connect account</strong>.",
    ],
    note: "A management key can administer your OpenRouter account. Stash uses it only to read credits. A regular model API key will not work here.",
  },
  "vercel-gateway": {
    steps: [
      `Open ${link("https://vercel.com/d?title=AI+Gateway+API+Keys&to=%2F%5Bteam%5D%2F~%2Fai-gateway%2Fapi-keys", "AI Gateway keys")} and select your Vercel team.`,
      "Choose <strong>Create key</strong> and name it <strong>Stash</strong>.",
      "Copy the key, paste it below, then click <strong>Connect account</strong>.",
    ],
    note: "This tracks your AI Gateway wallet. Stash only reads the balance; it does not make model requests.",
  },
  railway: {
    steps: [
      `Open ${link("https://railway.com/account/tokens", "Railway account tokens")} and create an account token with <strong>No workspace</strong> selected.`,
      "Paste the token and the ID of the workspace whose credits you want to track.",
      "Click <strong>Connect account</strong>.",
    ],
    note: "Already signed in with the Railway CLI? Leave the token blank to reuse that login.",
  },
};

function connectionHelp(id) {
  const guide = guides[id];
  if (!guide) return "";
  return `<section class="connection-help" aria-label="Connection steps">
    <h3>Get your key</h3>
    <ol>${guide.steps.map((step) => `<li>${step}</li>`).join("")}</ol>
    <p>${guide.note}</p>
  </section>`;
}

const $ = (s) => document.querySelector(s);
let state,
  selected,
  mode = "api",
  toastTimer,
  browserProvider,
  browserError,
  browserInitialUpdate,
  browserHint;
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
    a?.snapshot && a.threshold != null && Number(a.snapshot.value) < a.threshold
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
  const status = p.browserOpen
    ? "Finish setup"
    : a.error
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
    <div class="provider-cell"><span class="icon icon-${p.id}"><img src="/icons/${p.id}.${p.id === "higgsfield" ? "png" : "svg"}" alt="" width="24" height="24" /></span><div><h3>${esc(p.name)}</h3><span class="source">${p.id === "higgsfield" ? "API wallet" : a.mode === "api" ? "API" : "Browser"}</span></div></div>
    <div class="balance-cell"><div class="amount">${s ? money(s) : "—"}</div><div class="metric">${esc(s?.label || "Balance")}</div></div>
    <div class="status-cell"><span class="status ${needs ? "status-warning" : ""}"><span class="dot ${needs ? "" : "live"}"></span>${esc(status)}</span>${a.error ? `<p class="card-message">${esc(a.error)}</p>` : !s && a.mode === "browser" ? '<p class="card-message">Connect browser to select your balance.</p>' : ""}</div>
    <div class="row-actions">${a.mode === "browser" ? `<button class="icon-button" data-browser="${p.id}" aria-label="Connect browser for ${p.name}" title="Connect browser">▣</button>` : ""}<a class="icon-button" href="${esc(a.config.url || p.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${p.name} billing" title="Open billing">↗</a><button class="icon-button" data-refresh="${p.id}" aria-label="Refresh ${p.name}" title="Refresh" ${p.refreshing || p.browserOpen ? "disabled" : ""}>↻</button><button class="icon-button" data-manage="${p.id}" aria-label="Manage ${p.name}" title="Manage">···</button></div>
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
          `<button class="provider-option" data-manage="${p.id}" aria-label="Connect ${p.name}"><span class="icon icon-${p.id}"><img src="/icons/${p.id}.${p.id === "higgsfield" ? "png" : "svg"}" alt="" width="24" height="24" /></span><span>${esc(p.name)}</span><span class="option-plus" aria-hidden="true">+</span></button>`,
      )
      .join("") || "<p>All available providers are connected.</p>";
  $("#interval").value = state.interval;
  if (browserProvider) {
    const p = state.providers.find((p) => p.id === browserProvider);
    if (
      p?.account?.snapshot &&
      p.account.snapshot.updatedAt !== browserInitialUpdate
    )
      browserHint = null;
    $("#browser-status").textContent =
      browserError ||
      browserHint ||
      (p?.account?.snapshot &&
      p.account.snapshot.updatedAt !== browserInitialUpdate
        ? "Balance saved. Click Done to close the setup browser."
        : p?.browserOpen
          ? "Sign in, then click Find balance. No AI key needed."
          : "Open the browser to connect.");
  }
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
        `<button type="button" data-mode="${m}" class="${mode === m ? "active" : ""}">${m === "api" ? "API key" : "Browser sign-in"}</button>`,
    )
    .join("");
  const a = selected.account;
  if (mode === "api") {
    $("#fields").innerHTML =
      connectionHelp(selected.id) +
      `<label class="field">${esc(selected.apiLabel)}<input name="secret" type="password" autocomplete="off" ${selected.id === "railway" ? "" : "required"}></label>${selected.id === "railway" ? `<label class="field">Workspace ID<input name="scope" required value="${esc(a?.config.scope || "")}"></label><small>Leave the token empty to use your Railway CLI login.</small>` : ""}`;
  } else {
    $("#fields").innerHTML =
      `<label class="field">Billing page URL<input name="url" type="url" required value="${esc(a?.config.url || selected.url)}"></label><label class="field">Balance unit<select name="unit"><option>USD</option><option>credits</option><option>EUR</option><option>GBP</option></select></label><p>Sign in using a local browser. Your session stays on this computer.</p>`;
    $("[name=unit]").value = a?.config.unit || "USD";
  }
}
function openConnect(id) {
  $("#add-dialog").close();
  selected = state.providers.find((p) => p.id === id);
  mode = selected.account?.mode || (selected.api ? "api" : "browser");
  $("#connect-title").textContent = selected.name;
  $("#connect-form [name=provider]").value = id;
  $("#connect-form [name=threshold]").value = selected.account?.threshold ?? "";
  $("#disconnect").hidden = !selected.account;
  $("#form-error").textContent = "";
  fields();
  $("#connect-dialog").showModal();
}
async function showBrowser(id) {
  browserProvider = id;
  browserError = null;
  browserHint = null;
  $("#ai-setup").hidden = !state.ai?.enabled;
  $("#ai-setup").open = false;
  $("#ai-destination").textContent = state.ai?.enabled
    ? `Sends visible balance labels and amounts to ${state.ai.destination}${state.ai.local ? " on this computer" : " using your model key"}. You confirm the result. Scheduled refreshes never use AI.`
    : "";
  browserInitialUpdate = state.providers.find((p) => p.id === id)?.account
    ?.snapshot?.updatedAt;
  $("#browser-title").textContent = state.providers.find(
    (p) => p.id === id,
  ).name;
  $("#browser-dialog").showModal();
  await browserAction("open");
}
async function browserAction(action) {
  browserError = null;
  browserHint = null;
  const buttons = $("#browser-dialog").querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    await api("browser/" + action, { provider: browserProvider });
    if (["find", "assist"].includes(action))
      browserHint =
        "Check the suggested balance in the browser, then confirm it.";
    if (action === "select")
      browserHint = "Click your remaining balance in the browser.";
    await load();
    return true;
  } catch (e) {
    browserError = e.message;
    $("#browser-status").textContent = browserError;
    return false;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
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
    if (b.dataset.browser) await showBrowser(b.dataset.browser);
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
    if (mode === "browser") await showBrowser(selected.id);
    else toast("Connected. Checking balance.");
  } catch (err) {
    $("#form-error").textContent = err.message;
  } finally {
    b.disabled = false;
  }
});
$("#disconnect").onclick = async () => {
  if (
    !confirm(
      `Disconnect ${selected.name}? Its stored key, browser session, and balance will be removed.`,
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
$("#add-account").onclick = () => $("#add-dialog").showModal();
$("#browser-open").onclick = () => browserAction("open");
$("#browser-find").onclick = () => browserAction("find");
$("#browser-assist").onclick = () => browserAction("assist");
$("#browser-select").onclick = () => browserAction("select");
$("#browser-done").onclick = async () => {
  if (await browserAction("close")) $("#browser-dialog").close();
};
$("#browser-close").onclick = $("#browser-done").onclick;
$("#browser-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  if (!$("#browser-done").disabled) $("#browser-done").click();
});
await load();
setInterval(load, 4000);
