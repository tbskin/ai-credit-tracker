import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let csrf;
async function post(request, route, data) {
  const response = await request.post("/api/" + route, {
    headers: { "X-Tracker-CSRF": csrf },
    data,
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
test.beforeEach(async ({ request }) => {
  const state = await (await request.get("/api/state")).json();
  csrf = state.csrf;
  for (const p of state.providers)
    await post(request, "disconnect", { provider: p.id });
  await post(request, "settings", { interval: 0 });
});
test("connect, refresh, errors, disconnect and mobile layout", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Accounts", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh all", exact: true }),
  ).toBeDisabled();
  await page.locator("#add-account").click();
  await page.getByRole("button", { name: "Connect OpenRouter" }).click();
  await page.locator("[name=secret]").fill("fixture-key");
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await expect(
    page.locator(".card").filter({
      has: page.getByRole("heading", { name: "OpenRouter", exact: true }),
    }),
  ).toContainText("$42.50");
  await expect(page.locator("#connected")).toHaveText("1");
  await expect(page.locator("#total")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Refresh OpenRouter", exact: true })
    .click();
  await page.getByRole("button", { name: "Manage OpenRouter" }).click();
  await page.locator("[name=secret]").fill("rejected");
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await expect(page.locator(".card-message")).toContainText("Key rejected");
  await page.getByRole("button", { name: "Manage OpenRouter" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#connected")).toHaveText("0");
  await page.locator("#add-account").click();
  await expect(
    page.getByRole("button", { name: "Connect OpenRouter" }),
  ).toBeVisible();
  await page.locator("#add-dialog [data-close]").click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
});
test("real extension selects and refreshes all six providers against billing-page fixtures", async ({
  request,
}) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "credit-extension-"));
  const ext = path.join(tmp, "extension");
  fs.cpSync("extension", ext, { recursive: true });
  for (const file of ["background.js", "popup.html"]) {
    const target = path.join(ext, file);
    fs.writeFileSync(
      target,
      fs
        .readFileSync(target, "utf8")
        .replaceAll("localhost:4747", "localhost:4748"),
    );
  }
  // Grant optional host access up front in the isolated test profile. Production requests it on click.
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json")));
  manifest.host_permissions.push(...manifest.optional_host_permissions);
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(
    path.join(tmp, "profile"),
    {
      channel: "chromium",
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
      headless: true,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    },
  );
  try {
    let worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).hostname;
    const values = {
      openrouter: "101.25",
      openai: "42.50",
      higgsfield: "87.25",
      railway: "3.43",
      vercel: "5.10",
      supabase: "8.75",
    };
    const urls = {
      openrouter: "https://openrouter.ai/settings/credits",
      openai:
        "https://platform.openai.com/settings/organization/billing/overview",
      higgsfield: "https://console.higgsfield.ai/billing",
      railway: "https://railway.com/account/billing",
      vercel: "https://vercel.com/account/billing",
      supabase: "https://supabase.com/dashboard/org/test/billing",
    };
    let changedLayout = false;
    for (const [id, url] of Object.entries(urls)) {
      await context.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body><main><h1>${id} billing fixture</h1><section><h2>${changedLayout ? "Different account" : "Credit balance"}</h2><strong id="balance">$${values[id]}</strong></section></main></body></html>`,
        }),
      );
      await post(request, "connect", {
        provider: id,
        mode: "browser",
        url,
        kind: ["railway", "vercel", "supabase"].includes(id)
          ? "spend"
          : "balance",
        unit: "USD",
      });
    }
    const pairing = await post(request, "pair", {});
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator("#code").fill(pairing.code);
    await popup.getByRole("button", { name: "Pair with dashboard" }).click();
    await expect(popup.locator("#connected")).toBeVisible();
    for (const [id, url] of Object.entries(urls)) {
      const billing = await context.newPage();
      await billing.goto(url);
      // Trigger the picker through the extension's popup context, exactly as its button does after permission approval.
      const result = await popup.evaluate(async (id) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) =>
          t.url?.includes(
            id === "openai"
              ? "platform.openai.com"
              : id === "higgsfield"
                ? "console.higgsfield.ai"
                : id + ".",
          ),
        );
        return chrome.runtime.sendMessage({
          type: "pick",
          provider: id,
          tabId: tab.id,
        });
      }, id);
      expect(result.error).toBeUndefined();
      await billing.locator("#balance").click();
      // Closed shadow root is intentional. Use the extension's isolated world through CDP to click its confirmation via coordinates.
      const box = await billing.locator("#credit-tracker-picker").boundingBox();
      expect(box).toBeTruthy();
      await billing.mouse.click(box.x + 75, box.y + box.height - 36);
      await expect
        .poll(async () => {
          const state = await (await request.get("/api/state")).json();
          return state.providers.find((p) => p.id === id).account.snapshot
            ?.value;
        })
        .toBe(String(Number(values[id])));
      await billing.close();
    }
    const dashboard = await context.newPage();
    await dashboard.goto("http://localhost:4748");
    await expect(dashboard.locator("#connected")).toContainText("6");
    await expect(dashboard.locator("#total")).toHaveCount(0);
    await dashboard.screenshot({
      path: "test-results/dashboard-connected.png",
      fullPage: true,
    });
    values.higgsfield = "80.00";

    await post(request, "refresh", { provider: "higgsfield" });
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "status" }));
    await expect
      .poll(async () => {
        const state = await (await request.get("/api/state")).json();
        return state.providers.find((p) => p.id === "higgsfield").account
          .snapshot?.value;
      })
      .toBe("80");
    // A real Chrome alarm performs the next refresh with all dashboard/popup tabs closed.
    await dashboard.close();
    await popup.close();
    values.higgsfield = "79.25";
    await post(request, "refresh", { provider: "higgsfield" });
    await worker.evaluate(() =>
      chrome.alarms.create("credit-poll", { when: Date.now() + 1000 }),
    );
    await expect
      .poll(
        async () => {
          const state = await (await request.get("/api/state")).json();
          return state.providers.find((p) => p.id === "higgsfield").account
            .snapshot.value;
        },
        { timeout: 15000 },
      )
      .toBe("79.25");
    changedLayout = true;
    await post(request, "refresh", { provider: "higgsfield" });
    await worker.evaluate(() =>
      chrome.alarms.create("credit-poll", { when: Date.now() + 1000 }),
    );
    await expect
      .poll(
        async () => {
          const state = await (await request.get("/api/state")).json();
          return state.providers.find((p) => p.id === "higgsfield").account
            .error;
        },
        { timeout: 35000 },
      )
      .toContain("could not be read");
    const final = await (await request.get("/api/state")).json();
    const h = final.providers.find((p) => p.id === "higgsfield").account;
    expect(h.snapshot.value).toBe("79.25");
    expect(h.error).toContain("could not be read");
  } finally {
    await context.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
