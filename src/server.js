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
import { BrowserHarness } from "./browser/harness.js";
import { aiStatus } from "./browser/ai.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createApp({
  dir = process.env.CREDIT_TRACKER_DATA || path.join(root, ".private", "app"),
  port = Number(process.env.PORT || 4747),
  reader = readProvider,
  browser,
} = {}) {
  const store = new Store(dir),
    harness = browser || new BrowserHarness(dir),
    csrf = randomBytes(24).toString("hex"),
    busy = new Set();
  // Old versions stored usage as a snapshot. Never relabel that number as credits.
  let migrated = false;
  for (const [id, a] of Object.entries(store.data.accounts)) {
    if (
      a.mode === "browser" &&
      (a.config.kind === "spend" || a.snapshot?.kind === "spend")
    ) {
      delete a.config.selector;
      delete a.config.fingerprint;
      a.snapshot = null;
      a.error = "Select credits remaining in the local browser.";
      migrated = true;
    }
    if (a.snapshot?.kind !== "balance" && a.snapshot) {
      a.snapshot = null;
      migrated = true;
    }
    if (a.mode === "api" && !provider(id).api) {
      a.mode = "browser";
      a.secret = null;
      a.config = {
        url: provider(id).url,
        unit: "USD",
        kind: "balance",
        label: "Credits left",
      };
      a.error = "Connect with the local browser to read credits remaining.";
      migrated = true;
    }
    if (a.mode === "browser") {
      a.config.kind = "balance";
      a.config.label = "Credits left";
    }
  }
  if (store.data.bridgeToken) {
    store.data.bridgeToken = null;
    migrated = true;
  }
  if (migrated) store.save();
  const equal = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  function state() {
    return {
      csrf,
      ai: aiStatus(),
      interval: store.data.interval,
      providers: providers.map((p) => {
        const a = store.data.accounts[p.id];
        return {
          ...p,
          account: a
            ? Object.fromEntries(
                Object.entries(a).filter(([k]) => k !== "secret"),
              )
            : null,
          refreshing: busy.has(p.id),
          browserOpen: harness.isOpen(p.id),
        };
      }),
    };
  }
  async function refresh(id) {
    const a = store.data.accounts[id];
    if (!a || busy.has(id)) return;
    busy.add(id);
    a.lastAttempt = new Date().toISOString();
    a.error = null;
    try {
      const result =
        a.mode === "browser"
          ? await harness.read(id, a.config)
          : await reader(id, a.config, store.decrypt(a.secret));
      if (result.kind !== "balance")
        throw new ProviderError(
          "Provider returned usage instead of a balance.",
        );
      decimal(result.value);
      if (store.data.accounts[id] === a) {
        a.snapshot = {
          ...result,
          source: result.source || (a.mode === "api" ? "API" : "Browser"),
          updatedAt: new Date().toISOString(),
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
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  async function body(req) {
    let data = "";
    for await (const c of req) {
      data += c;
      if (data.length > 20000) throw new ProviderError("Request too large.");
    }
    return data ? JSON.parse(data) : {};
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const allowed = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!allowed.includes(req.headers.host))
      return json(res, 403, { error: "Unrecognized host." });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (
      req.headers.origin &&
      !allowed.some((h) => req.headers.origin === `http://${h}`)
    )
      return json(res, 403, { error: "Use the local dashboard." });
    if (req.method !== "GET" && !equal(req.headers["x-tracker-csrf"], csrf))
      return json(res, 403, { error: "Reload the dashboard and try again." });
    try {
      if (req.method === "GET" && url.pathname === "/api/state")
        return json(res, 200, state());
      if (req.method === "POST" && url.pathname === "/api/settings") {
        const b = await body(req);
        if (![0, 15, 30, 60, 180].includes(b.interval))
          throw new ProviderError("Choose a supported refresh interval.");
        store.data.interval = b.interval;
        store.save();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/connect") {
        const b = await body(req),
          p = provider(b.provider),
          old = store.data.accounts[p.id];
        if (busy.has(p.id) || harness.isOpen(p.id))
          throw new ProviderError(
            "Finish the current refresh or close the setup browser first.",
          );
        if (!["api", "browser"].includes(b.mode))
          throw new ProviderError("Choose a connection method.");
        let config;
        if (b.mode === "api") {
          if (!p.api)
            throw new ProviderError(
              "Connect this provider with the local browser.",
            );
          if (p.id !== "railway" && (!b.secret || typeof b.secret !== "string"))
            throw new ProviderError("Enter an API key.");
          if (
            p.id === "railway" &&
            !/^[-a-zA-Z0-9_]{1,128}$/.test(b.scope || "")
          )
            throw new ProviderError("Enter a valid workspace ID.");
          config = { scope: b.scope || "" };
        } else {
          if (!validPage(p.id, b.url))
            throw new ProviderError(
              "Use this provider’s HTTPS billing page URL.",
            );
          if (!["USD", "credits", "EUR", "GBP"].includes(b.unit))
            throw new ProviderError("Choose a unit.");
          if (b.kind && b.kind !== "balance")
            throw new ProviderError("Stash tracks remaining balances only.");
          config = {
            url: b.url,
            unit: b.unit,
            kind: "balance",
            label: "Credits left",
          };
          if (
            old?.mode === "browser" &&
            old.config.url === b.url &&
            old.config.unit === b.unit
          )
            config = { ...old.config, ...config };
        }
        if (
          b.threshold !== "" &&
          b.threshold != null &&
          (!Number.isFinite(Number(b.threshold)) || Number(b.threshold) < 0)
        )
          throw new ProviderError("Threshold must be zero or greater.");
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
      if (req.method === "POST" && url.pathname.startsWith("/api/browser/")) {
        const b = await body(req),
          p = provider(b.provider),
          a = store.data.accounts[p.id];
        if (!a || a.mode !== "browser")
          throw new ProviderError("Save a browser connection first.");
        if (busy.has(p.id))
          throw new ProviderError("Wait for the current refresh.");
        const action = url.pathname.split("/").at(-1);
        if (action === "open") {
          await harness.open(p.id, a.config, async (selection) => {
            if (store.data.accounts[p.id] !== a)
              throw new ProviderError("Connection changed.");
            a.config = {
              ...a.config,
              url: selection.url,
              selector: selection.selector,
              fingerprint: selection.fingerprint,
              contextSelector: selection.contextSelector,
              contextFingerprint: selection.contextFingerprint,
            };
            a.snapshot = {
              value: decimal(selection.value).toString(),
              kind: "balance",
              unit: a.config.unit,
              label: "Credits left",
              source: "Browser",
              updatedAt: new Date().toISOString(),
            };
            a.error = null;
            store.save();
          });
        } else if (action === "find") await harness.find(p.id, a.config);
        else if (action === "assist") await harness.find(p.id, a.config, true);
        else if (action === "select") await harness.select(p.id, a.config);
        else if (action === "close") await harness.close(p.id);
        else return json(res, 404, { error: "Not found." });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/disconnect") {
        const b = await body(req);
        provider(b.provider);
        if (busy.has(b.provider))
          throw new ProviderError("Wait for the current refresh.");
        await harness.forget(b.provider);
        delete store.data.accounts[b.provider];
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
        "/brand/wallet.svg": "brand/wallet.svg",
        "/brand/favicon.svg": "brand/favicon.svg",
        "/brand/favicon.ico": "brand/favicon.ico",
        "/brand/apple-touch-icon.png": "brand/apple-touch-icon.png",
      };
      files["/icons/higgsfield.png"] = "icons/higgsfield.png";
      for (const p of providers)
        files[`/icons/${p.id}.svg`] = `icons/${p.id}.svg`;
      if (
        req.method === "GET" &&
        files[url.pathname] &&
        fs.existsSync(path.join(root, "public", files[url.pathname]))
      ) {
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader(
          "Content-Type",
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
            ".png": "image/png",
          }[path.extname(url.pathname)] || "text/html",
        );
        return res.end(
          fs.readFileSync(path.join(root, "public", files[url.pathname])),
        );
      }
      return json(res, 404, { error: "Not found." });
    } catch (e) {
      json(res, 400, {
        error:
          e instanceof ProviderError
            ? e.message
            : e instanceof SyntaxError
              ? "Invalid request."
              : "Request failed. Retry or reconnect.",
      });
    }
  });
  async function tick() {
    if (!store.data.interval) return;
    await Promise.all(
      Object.entries(store.data.accounts)
        .filter(
          ([id, a]) =>
            !harness.isOpen(id) &&
            Date.now() -
              (Date.parse(a.lastAttempt || a.snapshot?.updatedAt) || 0) >
              store.data.interval * 60000,
        )
        .map(([id]) => refresh(id)),
    );
  }
  const timer = setInterval(() => void tick(), 15000);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    void harness.shutdown();
  });
  return {
    server,
    store,
    harness,
    refresh,
    tick,
    state,
    listen: () =>
      new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const app = createApp();
  await app.listen();
  console.log(`Stash is ready at http://localhost:${process.env.PORT || 4747}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await app.harness.shutdown();
      app.server.close(() => process.exit(0));
    });
}
