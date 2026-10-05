import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { BrowserHarness } from "../src/browser/harness.js";

test("real browser saves a selected balance and reuses its isolated session after restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-browser-"));
  let amount = "32.75",
    label = "Credits remaining",
    loginExpired = false,
    cookieSeen = false;
  const launch = async (profile, options) => {
    const ctx = await chromium.launchPersistentContext(profile, {
      ...options,
      headless: true,
    });
    await ctx.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.hostname !== "open.higgsfield.ai") return route.abort();
      cookieSeen = (route.request().headers().cookie || "").includes(
        "stash-fixture=connected",
      );
      if (loginExpired && u.pathname !== "/login")
        return route.fulfill({
          status: 302,
          headers: { location: "https://open.higgsfield.ai/login" },
        });
      return route.fulfill({
        contentType: "text/html",
        body: `<html><body><div>${label}<strong id="balance">$${amount}</strong></div></body></html>`,
      });
    });
    return ctx;
  };
  let harness = new BrowserHarness(dir, { launch, headlessSetup: true });
  let selected;
  try {
    const c = {
      url: "https://open.higgsfield.ai/billing",
      unit: "USD",
      kind: "balance",
      label: "Credits left",
    };
    await harness.open("higgsfield", c, async (s) => (selected = s));
    const session = harness.sessions.get("higgsfield");
    await session.context.addCookies([
      {
        name: "stash-fixture",
        value: "connected",
        domain: "open.higgsfield.ai",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
        secure: true,
      },
    ]);
    await harness.select("higgsfield", c);
    await session.page.locator("#balance").click();
    await session.page
      .getByRole("button", { name: "Use this balance" })
      .click();
    await session.page
      .getByText("Balance saved. Your dashboard is up to date.")
      .waitFor();
    assert.equal(selected.value, "32.75");
    await harness.close("higgsfield");
    harness = new BrowserHarness(dir, { launch, headlessSetup: true });
    amount = "27.5";
    const config = { ...c, ...selected };
    assert.equal((await harness.read("higgsfield", config)).value, "27.5");
    assert.ok(cookieSeen);
    label = "Monthly spend";
    await assert.rejects(
      () => harness.read("higgsfield", config),
      /could not be read/,
    );
    loginExpired = true;
    await assert.rejects(
      () => harness.read("higgsfield", config),
      /Sign in again/,
    );
    await harness.forget("higgsfield");
    assert.ok(!fs.existsSync(path.join(dir, "browser-profiles", "higgsfield")));
  } finally {
    await harness.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Supabase reads the exact dashboard response in cents, not a similarly named amount", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-supabase-"));
  const launch = async (profile, options) => {
    const ctx = await chromium.launchPersistentContext(profile, {
      ...options,
      headless: true,
    });
    await ctx.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === "api.supabase.com")
        return route.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ total_balance_cents: 12345, balance: 99999 }),
        });
      if (u.hostname === "supabase.com")
        return route.fulfill({
          contentType: "text/html",
          body: '<div>Credits <strong id="balance">$1</strong></div><script>fetch("https://api.supabase.com/platform/organizations/test-org/billing/credits/balance")</script>',
        });
      return route.abort();
    });
    return ctx;
  };
  const harness = new BrowserHarness(dir, { launch });
  try {
    const r = await harness.read("supabase", {
      url: "https://supabase.com/dashboard/org/test-org/billing",
      unit: "USD",
      selector: "#balance",
      fingerprint: "Credits #",
    });
    assert.equal(r.value, "123.45");
    assert.equal(r.source, "Dashboard API");
  } finally {
    await harness.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic discovery confirms one labelled balance and refuses ambiguous, spent or mismatched amounts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-discovery-"));
  const launch = async (profile, options) => {
    const ctx = await chromium.launchPersistentContext(profile, {
      ...options,
      headless: true,
    });
    await ctx.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div><h2>Credit balance</h2><div><strong id="remaining">$24.50</strong></div></div><div>Monthly spend <b>$78.00</b></div>',
      }),
    );
    return ctx;
  };
  let saved;
  let aiCalls = 0;
  const harness = new BrowserHarness(dir, {
    launch,
    aiChooser: async (_name, _unit, candidates) => {
      aiCalls++;
      return candidates[0];
    },
  });
  const config = {
    url: "https://platform.openai.com/settings/organization/billing/overview",
    unit: "USD",
    kind: "balance",
    label: "Credits left",
  };
  try {
    await harness.open("openai", config, async (value) => {
      saved = value;
    });
    const page = harness.sessions.get("openai").page;
    await harness.find("openai", config);
    assert.equal(
      saved,
      undefined,
      "discovery must not save an unconfirmed number",
    );
    assert.equal(aiCalls, 0, "default discovery must not invoke AI");
    await page.getByRole("button", { name: "Use this balance" }).click();
    await page
      .getByText("Balance saved. Your dashboard is up to date.")
      .waitFor();
    assert.equal(saved.value, "24.5");
    assert.ok(saved.contextSelector);
    await page
      .locator("#remaining")
      .evaluate((el) => (el.textContent = "$20.25"));
    assert.equal(
      await page.evaluate((c) => CreditReader.extract(c), saved),
      "20.25",
    );
    await page
      .locator("h2")
      .evaluate((el) => (el.textContent = "Monthly spend"));
    await assert.rejects(
      () => page.evaluate((c) => CreditReader.extract(c), saved),
      /label changed/,
    );
    for (const html of [
      "<div>Credit balance <b>$5</b><b>$10</b></div>",
      "<div>Monthly spend <b>$10</b></div>",
      "<div>Credit balance <b>€10</b></div>",
      '<div style="display:none">Credit balance <b>$10</b></div>',
      "<div>Monthly credit limit <b>$10</b></div>",
      "<div>Credit balance <b>$1.2k</b></div>",
    ]) {
      await page.setContent(html);
      await assert.rejects(
        () => harness.find("openai", config),
        /No clear|More than one/,
      );
    }
    await page.setContent("<div>Wallet <b>$14.50</b></div>");
    await assert.rejects(() => harness.find("openai", config), /No clear/);
    await harness.find("openai", config, true);
    assert.equal(aiCalls, 1);
    // AI only suggests; it cannot replace the prior saved balance without confirmation.
    assert.equal(saved.value, "24.5");
    await page.getByRole("button", { name: "Use this balance" }).click();
    await page
      .getByText("Balance saved. Your dashboard is up to date.")
      .waitFor();
    assert.equal(saved.value, "14.5");
  } finally {
    await harness.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
