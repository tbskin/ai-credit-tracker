const BASE = "http://localhost:4747";
const inFlight = new Set();
async function request(route, data) {
  const { token } = await chrome.storage.local.get("token");
  const res = await fetch(BASE + "/bridge/" + route, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(10000),
  });
  const result = await res.json();
  if (!res.ok)
    throw Error(result.error || "Open Credit Tracker and pair the extension.");
  return result;
}
function allowed(account, url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      account.hosts.includes(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
async function inject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["reader.js"],
  });
}
async function runJob(job, account) {
  if (inFlight.has(job.id)) return;
  inFlight.add(job.id);
  let tab;
  try {
    if (!account || !allowed(account, job.url))
      throw Error("Invalid billing page.");
    if (
      !(await chrome.permissions.contains({
        origins: [new URL(job.url).origin + "/*"],
      }))
    )
      throw Error("Grant access by selecting this balance again.");
    tab = await chrome.tabs.create({ url: "about:blank", active: false });
    await chrome.tabs.update(tab.id, { url: job.url });
    let value,
      done = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const current = await chrome.tabs.get(tab.id);
      if (current.status !== "complete") continue;
      if (!allowed(account, current.url) || current.url !== job.url)
        throw Error("Sign in to the billing page again.");
      try {
        await inject(tab.id);
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (config) => {
            try {
              return { value: globalThis.CreditReader.extract(config) };
            } catch {
              return { error: true };
            }
          },
          args: [job],
        });
        if (!results[0]?.result || results[0].result.error) continue;
        value = results[0].result.value;
        done = true;
        break;
      } catch {}
    }
    if (!done) throw Error("Balance could not be read.");
    await request("result", { provider: job.provider, jobId: job.id, value });
  } catch {
    try {
      await request("result", {
        provider: job.provider,
        jobId: job.id,
        error: true,
      });
    } catch {}
  } finally {
    if (tab)
      try {
        await chrome.tabs.remove(tab.id);
      } catch {}
    inFlight.delete(job.id);
  }
}
async function poll() {
  const result = await request("jobs");
  await chrome.storage.local.set({
    accounts: result.accounts,
    lastSeen: Date.now(),
  });
  for (let i = 0; i < result.jobs.length; i += 2)
    await Promise.all(
      result.jobs.slice(i, i + 2).map((job) =>
        runJob(
          job,
          result.accounts.find((a) => a.id === job.provider),
        ),
      ),
    );
  return result;
}
chrome.alarms.create("credit-poll", { periodInMinutes: 0.5 });
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("credit-poll", { periodInMinutes: 0.5 });
  poll().catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "credit-poll") poll().catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (
      message.type === "pair" &&
      sender.url === chrome.runtime.getURL("popup.html")
    ) {
      const result = await request("pair", { code: message.code });
      await chrome.storage.local.set({ token: result.token });
      return poll();
    }
    if (
      message.type === "status" &&
      sender.url === chrome.runtime.getURL("popup.html")
    )
      return poll();
    if (
      message.type === "pick" &&
      sender.url === chrome.runtime.getURL("popup.html")
    ) {
      const { accounts } = await poll();
      const account = accounts.find((a) => a.id === message.provider);
      const tab = await chrome.tabs.get(message.tabId);
      if (!account || !allowed(account, tab.url))
        throw Error(
          "Open this provider’s billing page in the active tab first.",
        );
      await inject(tab.id);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (config) => globalThis.CreditReader.pick(config),
        args: [account],
      });
      return { ok: true };
    }
    if (message.type === "capture" && sender.tab) {
      const { accounts } = await request("jobs");
      const account = accounts.find((a) => a.id === message.capture.provider);
      if (
        !account ||
        !allowed(account, sender.tab.url) ||
        message.capture.url !== sender.tab.url
      )
        throw Error("Billing page does not match this provider.");
      return request("capture", message.capture);
    }
    throw Error("Unsupported action.");
  })()
    .then(respond)
    .catch((e) => respond({ error: e.message }));
  return true;
});
