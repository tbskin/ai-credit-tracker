import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { readProvider, validPage, ProviderError } from "../src/providers.js";
import { Store } from "../src/store.js";
import { createApp } from "../src/server.js";
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "stash-test-"));
function fakeBrowser() {
  const sessions = new Map();
  return {
    sessions,
    isOpen: (id) => sessions.has(id),
    async open(id, c, fn) {
      sessions.set(id, { c, fn });
    },
    async select(id) {
      const { c, fn } = sessions.get(id);
      await fn({
        url: c.url,
        selector: "#balance",
        fingerprint: "Credits #",
        value: "9.5",
      });
    },
    async close(id) {
      sessions.delete(id);
    },
    async forget(id) {
      sessions.delete(id);
    },
    async read() {
      return { value: "8", unit: "USD", kind: "balance" };
    },
    async shutdown() {
      sessions.clear();
    },
  };
}
test("API readers return remaining credits, never usage or budgets", async () => {
  assert.equal(
    (
      await readProvider("openrouter", {}, "key", async () =>
        JSON.stringify({ data: { total_credits: 0.3, total_usage: 0.1 } }),
      )
    ).value,
    "0.2",
  );
  assert.equal(
    (
      await readProvider("vercel-gateway", {}, "key", async () =>
        JSON.stringify({ balance: "14.75", total_used: "999" }),
      )
    ).value,
    "14.75",
  );
  const r = await readProvider(
    "railway",
    { scope: "workspace" },
    "key",
    async (url, key, options) => {
      assert.equal(url, "https://backboard.railway.com/graphql/v2");
      const b = JSON.parse(options.body);
      assert.equal(b.variables.id, "workspace");
      assert.match(b.query, /creditBalance/);
      assert.doesNotMatch(b.query, /currentUsage/);
      return JSON.stringify({
        data: {
          workspace: {
            customer: {
              creditBalance: 12.5,
              currentUsage: 88,
              remainingUsageCreditBalance: 5,
            },
          },
        },
      });
    },
  );
  assert.equal(r.value, "12.5");
  assert.equal(r.kind, "balance");
  for (const id of ["openai", "vercel", "higgsfield", "supabase"])
    await assert.rejects(
      () => readProvider(id, {}, "key"),
      /No verified public balance API/,
    );
  await assert.rejects(
    () =>
      readProvider(
        "vercel-gateway",
        {},
        "key",
        async () => '{"total_used":"2"}',
      ),
    /Missing amount/,
  );
  await assert.rejects(
    () =>
      readProvider(
        "railway",
        { scope: "x" },
        "key",
        async () => '{"errors":[{}]}',
      ),
    /denied/,
  );
});
test("provider URL allowlists reject spoofed hosts and embedded credentials", () => {
  assert.ok(validPage("openai", "https://platform.openai.com/settings"));
  for (const url of [
    "https://platform.openai.com.evil.test",
    "http://platform.openai.com",
    "https://user:pass@platform.openai.com",
    "https://platform.openai.com:444",
  ])
    assert.equal(validPage("openai", url), false);
});
test("encrypted API keys persist without plaintext", () => {
  const dir = temp();
  try {
    const s = new Store(dir);
    s.data.secret = s.encrypt("sensitive-key");
    s.save();
    assert.ok(!fs.readFileSync(s.file, "utf8").includes("sensitive-key"));
    assert.equal(new Store(dir).decrypt(s.data.secret), "sensitive-key");
    assert.throws(() => s.decrypt(s.data.secret.slice(0, -4) + "AAAA"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("local server protects mutations and supports browser capture, refresh and disconnect", async () => {
  const dir = temp(),
    browser = fakeBrowser();
  let fail = false;
  const app = createApp({
    dir,
    port: 4321,
    browser,
    reader: async () => {
      if (fail) throw new ProviderError("Provider unavailable.");
      return { value: "25", unit: "USD", kind: "balance" };
    },
  });
  await app.listen();
  const request = async (route, body, headers = {}) => {
    const r = await fetch("http://localhost:4321" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    assert.equal((await request("/api/connect", {})).status, 403);
    const auth = { "X-Tracker-CSRF": (await request("/api/state")).data.csrf };
    assert.equal(
      (
        await request(
          "/api/connect",
          {},
          { ...auth, Origin: "https://evil.test" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/connect",
          { provider: "openrouter", mode: "api", secret: "private-key" },
          auth,
        )
      ).status,
      200,
    );
    await app.refresh("openrouter");
    let state = (await request("/api/state")).data;
    assert.equal(state.providers[0].account.snapshot.value, "25");
    assert.ok(!JSON.stringify(state).includes("private-key"));
    assert.ok(!JSON.stringify(state).includes("secret"));
    fail = true;
    await app.refresh("openrouter");
    assert.equal(app.state().providers[0].account.snapshot.value, "25");
    assert.equal(
      app.state().providers[0].account.error,
      "Provider unavailable.",
    );
    assert.equal(
      (
        await request(
          "/api/connect",
          { provider: "openai", mode: "api", secret: "x" },
          auth,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          "/api/connect",
          {
            provider: "higgsfield",
            mode: "browser",
            url: "https://open.higgsfield.ai",
            unit: "USD",
            kind: "spend",
          },
          auth,
        )
      ).status,
      400,
    );
    await request(
      "/api/connect",
      {
        provider: "higgsfield",
        mode: "browser",
        url: "https://open.higgsfield.ai",
        unit: "USD",
      },
      auth,
    );
    await request("/api/browser/open", { provider: "higgsfield" }, auth);
    await request("/api/browser/select", { provider: "higgsfield" }, auth);
    assert.equal(app.store.data.accounts.higgsfield.snapshot.value, "9.5");
    assert.ok(
      app.state().providers.find((p) => p.id === "higgsfield").browserOpen,
    );
    await app.refresh("higgsfield");
    assert.equal(app.store.data.accounts.higgsfield.snapshot.value, "9.5");
    assert.equal(app.store.data.accounts.higgsfield.error, null);
    assert.equal(
      (await request("/api/refresh", { provider: "higgsfield" }, auth)).status,
      400,
    );
    await request("/api/browser/close", { provider: "higgsfield" }, auth);
    await app.refresh("higgsfield");
    assert.equal(app.store.data.accounts.higgsfield.snapshot.value, "8");
    await request("/api/disconnect", { provider: "higgsfield" }, auth);
    assert.equal(app.store.data.accounts.higgsfield, undefined);
    assert.equal((await request("/bridge/jobs")).status, 404);
  } finally {
    await new Promise((r) => app.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("scheduler runs without dashboard and prevents overlapping refresh", async () => {
  const dir = temp();
  let calls = 0,
    release;
  const app = createApp({
    dir,
    browser: fakeBrowser(),
    reader: async () => {
      calls++;
      await new Promise((r) => (release = r));
      return { value: "7", unit: "USD", kind: "balance" };
    },
  });
  try {
    app.store.data.accounts.openrouter = {
      mode: "api",
      config: {},
      secret: app.store.encrypt("key"),
    };
    app.store.data.interval = 0;
    await app.tick();
    assert.equal(calls, 0);
    app.store.data.interval = 15;
    const pending = app.tick();
    await app.tick();
    assert.equal(calls, 1);
    release();
    await pending;
    await app.tick();
    assert.equal(calls, 1);
  } finally {
    app.server.emit("close");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("migration discards spend snapshots instead of relabeling them", () => {
  const dir = temp();
  try {
    const s = new Store(dir);
    s.data.accounts = {
      openai: {
        mode: "api",
        config: {},
        secret: s.encrypt("old"),
        snapshot: { kind: "spend", value: "99" },
      },
      railway: {
        mode: "api",
        config: { scope: "abc" },
        snapshot: { kind: "spend", value: "55" },
      },
    };
    s.save();
    const app = createApp({ dir, browser: fakeBrowser() });
    assert.equal(app.store.data.accounts.openai.mode, "browser");
    assert.equal(app.store.data.accounts.openai.secret, null);
    assert.equal(app.store.data.accounts.railway.snapshot, null);
    app.server.emit("close");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("parser rejects ambiguous balances", () => {
  const c = {};
  runInNewContext(fs.readFileSync("src/browser/reader.js", "utf8"), c);
  const parse = c.CreditReader.parse;
  assert.equal(parse("$1,234.56"), "1234.56");
  assert.equal(parse("-$12.50"), "-12.50");
  assert.equal(parse("0 credits"), "0");
  for (const v of ["50%", "10 of 100", "$1.2k", "1,23", "($1)", "No balance"])
    assert.throws(() => parse(v));
});
