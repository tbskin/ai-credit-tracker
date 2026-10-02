import { ProviderError } from "../src/providers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";
import { Store } from "../src/store.js";
import { readProvider, validPage } from "../src/providers.js";

test("provider sums decimals and paginates without inventing a wallet balance", async () => {
  const r = await readProvider("openrouter", {}, "key", async () =>
    JSON.stringify({ data: { total_credits: 0.3, total_usage: 0.1 } }),
  );
  assert.equal(r.value, "0.2");
  assert.equal(r.kind, "balance");
  let requests = 0;
  const o = await readProvider("openai", {}, "key", async (url) => {
    requests++;
    if (requests === 2) assert.match(url, /page=next/);
    return JSON.stringify({
      data: [{ results: [{ amount: { currency: "usd", value: 0.1 } }] }],
      has_more: requests === 1,
      next_page: "next",
    });
  });
  assert.equal(o.value, "0.2");
  assert.equal(o.kind, "spend");
  await assert.rejects(
    () =>
      readProvider("openai", {}, "key", async () =>
        JSON.stringify({ data: [], has_more: true, next_page: null }),
      ),
    /Incomplete/,
  );
});
test("Vercel includes credits/adjustments and rejects unknown currency", async () => {
  const read = async () =>
    '{"BilledCost":"10","BillingCurrency":"USD"}\n{"BilledCost":"-2","BillingCurrency":"USD"}';
  assert.equal(
    (await readProvider("vercel", { scope: "team" }, "key", read)).value,
    "8",
  );
  await assert.rejects(
    () =>
      readProvider(
        "vercel",
        { scope: "team" },
        "key",
        async () => '{"BilledCost":"1","BillingCurrency":"EUR"}',
      ),
    /currency/,
  );
});
test("billing URLs are restricted to the selected provider", () => {
  assert.equal(
    validPage("openai", "https://platform.openai.com/settings"),
    true,
  );
  for (const url of [
    "https://platform.openai.com.evil.test",
    "http://platform.openai.com",
    "https://user:pass@platform.openai.com",
    "https://platform.openai.com:444",
  ])
    assert.equal(validPage("openai", url), false);
});
test("credentials are authenticated-encrypted and persist without plaintext", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-store-"));
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
test("server guards connections, retains failed snapshots, and completes browser refresh", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-app-"));
  let fail = false;
  const app = createApp({
    dir,
    port: 4321,
    reader: async () => {
      if (fail) throw new ProviderError("Provider unavailable.");
      return {
        value: "25",
        unit: "USD",
        kind: "balance",
        label: "Credit balance",
      };
    },
  });
  await app.listen();
  const base = "http://localhost:4321";
  const request = async (route, body, headers = {}) => {
    const r = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    assert.equal((await request("/api/connect", {})).status, 403);
    assert.equal(
      (await request("/bridge/jobs", undefined, { Authorization: "Bearer " }))
        .status,
      403,
    );
    const { data: state } = await request("/api/state");
    const auth = { "X-Tracker-CSRF": state.csrf };
    assert.equal(
      (
        await request(
          "/api/connect",
          { provider: "openrouter", mode: "api", secret: "private-key" },
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
    await new Promise((r) => setTimeout(r, 20));
    let s = (await request("/api/state")).data;
    assert.equal(s.providers[0].account.snapshot.value, "25");
    assert.ok(!JSON.stringify(s).includes("private-key"));
    assert.ok(!JSON.stringify(s).includes("secret"));
    fail = true;
    await app.refresh("openrouter");
    s = (await request("/api/state")).data;
    assert.equal(s.providers[0].account.snapshot.value, "25");
    assert.equal(s.providers[0].account.error, "Provider unavailable.");
    const pairing = (await request("/api/pair", {}, auth)).data;
    const token = (await request("/bridge/pair", { code: pairing.code })).data
      .token;
    const bridge = { Authorization: "Bearer " + token };
    assert.equal(
      (await request("/bridge/pair", { code: pairing.code })).status,
      403,
    );
    await request(
      "/api/connect",
      {
        provider: "higgsfield",
        mode: "browser",
        url: "https://console.higgsfield.ai",
        kind: "balance",
        unit: "USD",
      },
      auth,
    );
    assert.equal(
      (
        await request(
          "/bridge/capture",
          {
            provider: "higgsfield",
            url: "https://evil.test",
            value: "10",
            selector: "#balance",
            fingerprint: "Balance #",
          },
          bridge,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          "/bridge/capture",
          {
            provider: "higgsfield",
            url: "https://console.higgsfield.ai",
            value: "10",
            selector: "#balance",
            fingerprint: "Balance #",
          },
          bridge,
        )
      ).status,
      200,
    );
    await app.refresh("higgsfield");
    const job = (await request("/bridge/jobs", undefined, bridge)).data.jobs[0];
    await request(
      "/bridge/result",
      { provider: "higgsfield", jobId: job.id, value: "9.5" },
      bridge,
    );
    assert.equal(
      (await request("/api/state")).data.providers[2].account.snapshot.value,
      "9.5",
    );
    assert.equal(
      (
        await request(
          "/bridge/result",
          { provider: "higgsfield", jobId: job.id, value: "8" },
          bridge,
        )
      ).status,
      409,
    );
    await request("/api/unpair", {}, auth);
    assert.equal(
      (await request("/bridge/jobs", undefined, bridge)).status,
      403,
    );
    await request("/api/disconnect", { provider: "openrouter" }, auth);
    assert.equal(app.store.data.accounts.openrouter, undefined);
  } finally {
    await new Promise((r) => app.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduled refresh works without a dashboard request and does not overlap", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-schedule-"));
  let calls = 0,
    release;
  const app = createApp({
    dir,
    port: 4322,
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
    const running = app.tick();
    await app.tick();
    assert.equal(calls, 1);
    release();
    await running;
    assert.equal(app.state().providers[0].account.snapshot.value, "7");
    await app.tick();
    assert.equal(calls, 1);
  } finally {
    app.server.emit("close");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("browser amount parser rejects ambiguous amounts and preserves negatives", async () => {
  const { runInNewContext } = await import("node:vm");
  const context = {};
  runInNewContext(fs.readFileSync("extension/reader.js", "utf8"), context);
  const parse = context.CreditReader.parse;
  assert.equal(parse("$1,234.56"), "1234.56");
  assert.equal(parse("-$12.50"), "-12.50");
  assert.equal(parse("0 credits"), "0");
  for (const text of [
    "50%",
    "10 of 100",
    "$1.2k",
    "1,23",
    "($1)",
    "No balance",
  ])
    assert.throws(() => parse(text), text);
});
