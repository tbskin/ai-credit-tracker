import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Store } from "./store.js";
import {
  providers,
  provider,
  validPage,
  decimal,
  readProvider,
  ProviderError,
} from "./providers.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createApp({
  dir = process.env.CREDIT_TRACKER_DATA || path.join(root, ".private", "app"),
  port = Number(process.env.PORT || 4747),
  reader = readProvider,
} = {}) {
  const store = new Store(dir),
    csrf = randomBytes(24).toString("hex"),
    busy = new Set(),
    jobs = new Map();
  let pairing = null,
    bridgeSeen = 0;
  const equal = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const safeAccount = (a) =>
    a
      ? Object.fromEntries(Object.entries(a).filter(([k]) => k !== "secret"))
      : null;
  function state() {
    return {
      csrf,
      interval: store.data.interval,
      bridgeConnected: Date.now() - bridgeSeen < 90000,
      providers: providers.map((p) => ({
        ...p,
        account: safeAccount(store.data.accounts[p.id]),
        refreshing: busy.has(p.id) || jobs.has(p.id),
      })),
    };
  }
  async function refresh(id) {
    const a = store.data.accounts[id];
    if (!a || busy.has(id) || jobs.has(id)) return;
    if (a.mode === "browser") {
      if (!a.config.selector) {
        a.error = "Choose a balance on the billing page using the extension.";
        store.save();
        return;
      }
      jobs.set(id, {
        id: randomBytes(12).toString("hex"),
        provider: id,
        url: a.config.url,
        selector: a.config.selector,
        fingerprint: a.config.fingerprint,
        unit: a.config.unit,
        kind: a.config.kind,
        label: a.config.label,
        created: Date.now(),
      });
      return;
    }
    busy.add(id);
    a.lastAttempt = new Date().toISOString();
    a.error = null;
    try {
      const result = await reader(id, a.config, store.decrypt(a.secret));
      if (store.data.accounts[id] === a) {
        a.snapshot = {
          ...result,
          updatedAt: new Date().toISOString(),
          source: "API",
        };
        a.error = null;
      }
    } catch (e) {
      if (store.data.accounts[id] === a)
        a.error =
          e instanceof ProviderError
            ? e.message
            : "Unexpected provider response. Reconnect or retry.";
    } finally {
      busy.delete(id);
      store.save();
    }
  }
  function json(res, status, data) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  }
  async function body(req) {
    let data = "";
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 20000) throw Error("Request too large.");
    }
    return data ? JSON.parse(data) : {};
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const host = req.headers.host,
      allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!allowedHosts.includes(host))
      return json(res, 403, { error: "Unrecognized host." });
    const url = new URL(req.url, `http://${host}`),
      origin = req.headers.origin;
    const bridge = url.pathname.startsWith("/bridge/");
    if (bridge && origin?.startsWith("chrome-extension://")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
    }
    try {
      if (bridge) {
        if (req.method === "POST" && url.pathname === "/bridge/pair") {
          const b = await body(req);
          if (
            !pairing ||
            pairing.expires < Date.now() ||
            !equal(b.code, pairing.code)
          )
            return json(res, 403, {
              error: "Pairing code expired or incorrect.",
            });
          const token = randomBytes(32).toString("hex");
          store.data.bridgeToken = store.encrypt(token);
          store.save();
          pairing = null;
          bridgeSeen = Date.now();
          return json(res, 200, { token });
        }
        if (
          !store.data.bridgeToken ||
          !equal(
            req.headers.authorization,
            `Bearer ${store.decrypt(store.data.bridgeToken)}`,
          )
        )
          return json(res, 403, {
            error: "Pair the extension from the dashboard.",
          });
        bridgeSeen = Date.now();
        if (req.method === "GET" && url.pathname === "/bridge/jobs")
          return json(res, 200, {
            jobs: [...jobs.values()],
            accounts: providers
              .filter((p) => store.data.accounts[p.id]?.mode === "browser")
              .map((p) => ({
                id: p.id,
                name: p.name,
                hosts: p.hosts,
                ...store.data.accounts[p.id].config,
              })),
          });
        if (req.method === "POST" && url.pathname === "/bridge/capture") {
          const b = await body(req),
            a = store.data.accounts[b.provider];
          if (
            !a ||
            a.mode !== "browser" ||
            !validPage(b.provider, b.url) ||
            typeof b.selector !== "string" ||
            b.selector.length > 1500 ||
            !b.selector ||
            typeof b.fingerprint !== "string" ||
            b.fingerprint.length > 500
          )
            throw Error("Invalid balance selection.");
          const value = decimal(b.value).toString();
          a.config = {
            ...a.config,
            url: b.url,
            selector: b.selector,
            fingerprint: b.fingerprint,
          };
          a.snapshot = {
            value,
            unit: a.config.unit,
            kind: a.config.kind,
            label: a.config.label,
            detail: "Selected on your billing page",
            source: "Browser",
            updatedAt: new Date().toISOString(),
          };
          a.error = null;
          jobs.delete(b.provider);
          store.save();
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/bridge/result") {
          const b = await body(req),
            job = jobs.get(b.provider),
            a = store.data.accounts[b.provider];
          if (!job || job.id !== b.jobId || !a || a.mode !== "browser")
            return json(res, 409, { error: "Refresh no longer pending." });
          if (b.error) {
            a.error =
              "Balance could not be read. Open billing, sign in if needed, and select the balance again.";
          } else {
            a.snapshot = {
              value: decimal(b.value).toString(),
              unit: a.config.unit,
              kind: a.config.kind,
              label: a.config.label,
              detail: "Selected on your billing page",
              source: "Browser",
              updatedAt: new Date().toISOString(),
            };
            a.error = null;
          }
          a.lastAttempt = new Date().toISOString();
          jobs.delete(b.provider);
          store.save();
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Not found." });
      }
      if (origin && !allowedHosts.some((h) => origin === `http://${h}`))
        return json(res, 403, { error: "Use the local dashboard." });
      if (req.method !== "GET" && !equal(req.headers["x-tracker-csrf"], csrf))
        return json(res, 403, { error: "Reload the dashboard and try again." });
      if (req.method === "GET" && url.pathname === "/api/state")
        return json(res, 200, state());
      if (req.method === "POST" && url.pathname === "/api/pair") {
        pairing = {
          code: randomBytes(16).toString("hex"),
          expires: Date.now() + 300000,
        };
        return json(res, 200, pairing);
      }
      if (req.method === "POST" && url.pathname === "/api/unpair") {
        store.data.bridgeToken = null;
        bridgeSeen = 0;
        store.save();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        const b = await body(req);
        if (![15, 30, 60, 180, 0].includes(b.interval))
          throw Error("Choose a supported refresh interval.");
        store.data.interval = b.interval;
        store.save();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/connect") {
        const b = await body(req),
          p = provider(b.provider);
        if (!["api", "browser"].includes(b.mode))
          throw Error("Choose a connection method.");
        let config;
        if (b.mode === "api") {
          if (!p.api)
            throw Error("Use the browser connection for this provider.");
          if (
            p.id !== "railway" &&
            (typeof b.secret !== "string" || !b.secret.trim())
          )
            throw Error("Enter a key.");
          if (
            ["railway", "vercel"].includes(p.id) &&
            !/^[-a-zA-Z0-9_]{1,128}$/.test(b.scope || "")
          )
            throw Error("Enter a valid workspace or team ID.");
          config = { scope: b.scope || "" };
        } else {
          if (!validPage(p.id, b.url))
            throw Error("Use this provider’s HTTPS billing page URL.");
          if (
            !["balance", "spend", "allowance"].includes(b.kind) ||
            !["USD", "credits", "EUR", "GBP"].includes(b.unit)
          )
            throw Error("Choose a metric and unit.");
          config = {
            url: b.url,
            kind: b.kind,
            unit: b.unit,
            label: {
              balance: "Credit balance",
              spend: "Used this billing period",
              allowance: "Allowance remaining",
            }[b.kind],
          };
        }
        if (
          b.threshold !== "" &&
          b.threshold != null &&
          (!Number.isFinite(Number(b.threshold)) || Number(b.threshold) < 0)
        )
          throw Error("Threshold must be zero or greater.");
        jobs.delete(p.id);
        store.data.accounts[p.id] = {
          mode: b.mode,
          config,
          secret: b.mode === "api" ? store.encrypt(b.secret || "") : null,
          threshold:
            b.threshold === "" || b.threshold == null
              ? null
              : Number(b.threshold),
          snapshot: null,
          error: null,
        };
        store.save();
        if (b.mode === "api") void refresh(p.id);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/disconnect") {
        const b = await body(req);
        provider(b.provider);
        delete store.data.accounts[b.provider];
        jobs.delete(b.provider);
        store.save();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        const b = await body(req);
        if (b.provider) {
          provider(b.provider);
          void refresh(b.provider);
        } else for (const p of providers) void refresh(p.id);
        return json(res, 202, { ok: true });
      }
      const files = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
      };
      if (req.method === "GET" && files[url.pathname]) {
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        res.setHeader(
          "Content-Type",
          url.pathname.endsWith(".js")
            ? "text/javascript"
            : url.pathname.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        return res.end(
          fs.readFileSync(path.join(root, "public", files[url.pathname])),
        );
      }
      json(res, 404, { error: "Not found." });
    } catch (e) {
      json(res, 400, {
        error:
          e instanceof SyntaxError
            ? "Invalid request."
            : e.message?.slice(0, 180) || "Request failed.",
      });
    }
  });
  async function tick() {
    const pending = [];
    for (const [id, job] of jobs) {
      if (Date.now() - job.created > 120000) {
        jobs.delete(id);
        const a = store.data.accounts[id];
        if (a) {
          a.error =
            "Browser refresh timed out. Keep Chrome and the extension running.";
          a.lastAttempt = new Date().toISOString();
          store.save();
        }
      }
    }
    if (store.data.interval)
      for (const [id, a] of Object.entries(store.data.accounts)) {
        const last =
          Date.parse(a.lastAttempt || a.snapshot?.updatedAt || 0) || 0;
        if (Date.now() - last > store.data.interval * 60000)
          pending.push(refresh(id));
      }
    await Promise.all(pending);
  }
  const timer = setInterval(() => {
    void tick();
  }, 15000);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return {
    server,
    store,
    refresh,
    tick,
    state,
    listen: () =>
      new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  await app.listen();
  console.log(
    `Credit Tracker is ready at http://localhost:${process.env.PORT || 4747}`,
  );
}
