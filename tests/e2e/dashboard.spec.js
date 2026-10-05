import { test, expect } from "@playwright/test";
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

test("browser connection selects a balance and refreshes after setup closes", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#add-account").click();
  await expect(page.locator(".provider-option")).toHaveCount(7);
  await page
    .getByRole("button", { name: "Connect OpenAI", exact: true })
    .click();
  await expect(page.locator("[name=secret]")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await expect(page.locator("#browser-status")).toContainText(
    "No AI key needed",
  );
  await expect(page.locator("#ai-setup")).toBeHidden();
  await page.screenshot({
    path: "test-results/browser-setup-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/browser-setup-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Find balance", exact: true }).click();
  await expect(page.locator("#browser-status")).toContainText(
    "Check the suggested balance",
  );
  await page
    .getByRole("button", { name: "Select manually", exact: true })
    .click();
  await expect(page.locator("#browser-status")).toContainText("Balance saved");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".amount")).toHaveText("$19.75");
  await page
    .getByRole("button", { name: "Refresh OpenAI", exact: true })
    .click();
  await expect(page.locator(".amount")).toHaveText("$18.50");
  await page.screenshot({
    path: "test-results/browser-account-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/browser-account-mobile.png",
    fullPage: true,
  });
});
