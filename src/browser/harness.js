import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { provider, validPage, decimal, ProviderError } from "../providers.js";
import { balanceLabels } from "./discovery.js";
import { chooseCandidate } from "./ai.js";
const readerScript = fs.readFileSync(
  fileURLToPath(new URL("./reader.js", import.meta.url)),
  "utf8",
);

// One isolated profile per provider. No access to the user's everyday browser profile.
export class BrowserHarness {
  constructor(
    dir,
    {
      launch = (profile, options) =>
        chromium.launchPersistentContext(profile, options),
      headlessSetup = false,
      aiChooser = chooseCandidate,
    } = {},
  ) {
    this.dir = path.join(dir, "browser-profiles");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.launch = launch;
    this.headlessSetup = headlessSetup;
    this.aiChooser = aiChooser;
    this.sessions = new Map();
    this.pending = new Set();
  }
  isOpen(id) {
    return this.sessions.has(id) || this.pending.has(id);
  }
  async context(id, headless) {
    provider(id);
    const profile = path.join(this.dir, id);
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    try {
      return await this.launch(profile, {
        headless,
        viewport: { width: 1200, height: 850 },
        acceptDownloads: false,
        ...(process.env.STASH_BROWSER_EXECUTABLE ||
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? {
              executablePath:
                process.env.STASH_BROWSER_EXECUTABLE ||
                process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
            }
          : {}),
      });
    } catch {
      throw new ProviderError(
        "Browser could not start. Run npm run browser:install. On Linux, setup needs a desktop display.",
      );
    }
  }
  async open(id, config, capture) {
    if (!validPage(id, config.url))
      throw new ProviderError("Use this provider’s billing URL.");
    if (this.pending.has(id))
      throw new ProviderError("Browser is starting. Try again shortly.");
    const existing = this.sessions.get(id);
    if (existing) {
      await existing.page.bringToFront();
      return;
    }
    this.pending.add(id);
    let context;
    try {
      context = await this.context(id, this.headlessSetup);
      const page = context.pages()[0] || (await context.newPage());
      const session = { context, page, timer: null };
      await context.exposeBinding(
        "__stashCapture",
        async ({ page: sender, frame }, selection) => {
          if (
            sender !== session.page ||
            frame !== sender.mainFrame() ||
            !validPage(id, sender.url()) ||
            selection?.url !== sender.url()
          )
            return { error: "Open the correct provider billing page." };
          if (
            typeof selection.selector !== "string" ||
            selection.selector.length > 1500 ||
            typeof selection.fingerprint !== "string" ||
            selection.fingerprint.length > 500 ||
            (selection.contextSelector != null &&
              (typeof selection.contextSelector !== "string" ||
                selection.contextSelector.length > 1500 ||
                typeof selection.contextFingerprint !== "string" ||
                selection.contextFingerprint.length > 500))
          )
            return { error: "Select the balance again." };
          try {
            // Re-read the selected element rather than trusting the submitted number.
            const value = await sender.evaluate(
              (c) => globalThis.CreditReader.extract(c),
              selection,
            );
            await capture({
              ...selection,
              provider: id,
              value: decimal(value).toString(),
            });
            return { ok: true };
          } catch {
            return {
              error: "Balance changed or selection expired. Select it again.",
            };
          }
        },
      );
      context.on("close", () => {
        clearTimeout(session.timer);
        if (this.sessions.get(id) === session) this.sessions.delete(id);
      });
      this.sessions.set(id, session);
      session.timer = setTimeout(() => {
        void this.close(id);
      }, 15 * 60000);
      session.timer.unref();
      await page.goto(config.url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    } catch (e) {
      await context?.close().catch(() => {});
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(
        "Billing page could not open. Check the URL and try again.",
      );
    } finally {
      this.pending.delete(id);
    }
  }
  async select(id, config) {
    const session = this.sessions.get(id);
    if (this.pending.has(id))
      throw new ProviderError("Wait for the current browser operation.");
    if (!session)
      throw new ProviderError("Open the browser and sign in first.");
    // Login can open a new tab; choose only a matching provider tab.
    const pages = session.context.pages().filter((p) => validPage(id, p.url()));
    const page = pages.at(-1);
    if (!page)
      throw new ProviderError(
        "Finish signing in and open the billing page first.",
      );
    session.page = page;
    await page.evaluate(readerScript);
    await page.evaluate((c) => globalThis.CreditReader.pick(c), {
      ...config,
      id,
      name: provider(id).name,
    });
    await page.bringToFront();
  }
  async find(id, config, useAI = false) {
    const session = this.sessions.get(id);
    if (!session)
      throw new ProviderError("Open the browser and sign in first.");
    if (this.pending.has(id))
      throw new ProviderError("Wait for the current browser operation.");
    this.pending.add(id);
    try {
      const page = session.context
        .pages()
        .filter((p) => validPage(id, p.url()))
        .at(-1);
      if (!page)
        throw new ProviderError(
          "Finish signing in and open the billing page first.",
        );
      session.page = page;
      await page.evaluate(readerScript);
      const settings = {
        ...config,
        id,
        name: provider(id).name,
        labels: balanceLabels[id],
      };
      const candidates = await page.evaluate(
        (c) => globalThis.CreditReader.candidates(c),
        settings,
      );
      if (candidates.length > 30)
        throw new ProviderError(
          "Too many possible balances. Select the correct wallet manually.",
        );
      const exact = candidates.filter((c) => c.automatic);
      let proposal;
      if (useAI)
        proposal = await this.aiChooser(
          provider(id).name + (id === "higgsfield" ? " API wallet" : ""),
          config.unit,
          candidates,
        );
      else if (exact.length === 1) proposal = exact[0];
      else
        throw new ProviderError(
          exact.length > 1
            ? "More than one possible balance. Select the correct wallet manually."
            : "No clear remaining balance found. Open your billing page, or select it manually.",
        );
      // The model returns a nomination only. Re-read it, then require confirmation in the browser.
      await page.evaluate(
        ({ settings, proposal }) =>
          globalThis.CreditReader.pick(settings, proposal),
        { settings, proposal },
      );
      await page.bringToFront();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "Page changed during discovery. Try again or select manually.",
      );
    } finally {
      this.pending.delete(id);
    }
  }
  async read(id, config) {
    if (this.isOpen(id))
      throw new ProviderError("Close the setup browser before refreshing.");
    if (!config.selector)
      throw new ProviderError(
        "Connect your browser and select the credits remaining.",
      );
    if (!validPage(id, config.url))
      throw new ProviderError("Invalid billing URL. Reconnect this account.");
    this.pending.add(id);
    let context;
    try {
      context = await this.context(id, true);
      const page = context.pages()[0] || (await context.newPage());
      const supabaseSlug =
        id === "supabase"
          ? new URL(config.url).pathname.match(
              /^\/dashboard\/org\/([^/]+)\/billing\/?$/,
            )?.[1]
          : null;
      const balanceResponse =
        supabaseSlug && config.unit === "USD"
          ? page
              .waitForResponse(
                (response) => {
                  const u = new URL(response.url());
                  return (
                    u.origin === "https://api.supabase.com" &&
                    u.pathname ===
                      `/platform/organizations/${supabaseSlug}/billing/credits/balance` &&
                    response.ok()
                  );
                },
                { timeout: 12000 },
              )
              .catch(() => null)
          : Promise.resolve(null);
      await page.goto(config.url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      // A login redirect must never be treated as a balance of zero.
      if (page.url() !== config.url)
        throw new ProviderError(
          "Sign in again, or select the balance on the updated billing page.",
        );
      const response = await balanceResponse;
      if (response) {
        try {
          const data = await response.json();
          if (Number.isSafeInteger(data.total_balance_cents))
            return {
              value: decimal(data.total_balance_cents).div(100).toString(),
              unit: "USD",
              kind: "balance",
              label: "Credits left",
              source: "Dashboard API",
            };
        } catch {
          /* Keep the confirmed page selection as a fallback. */
        }
      }
      await page
        .locator(config.selector)
        .waitFor({ state: "visible", timeout: 20000 });
      await page.evaluate(readerScript);
      const value = await page.evaluate(
        (c) => globalThis.CreditReader.extract(c),
        config,
      );
      return {
        value: decimal(value).toString(),
        unit: config.unit,
        kind: "balance",
        label: "Credits left",
      };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(
        "Balance could not be read. Sign in again or select the balance if the page changed.",
      );
    } finally {
      await context?.close().catch(() => {});
      this.pending.delete(id);
    }
  }
  async close(id) {
    const session = this.sessions.get(id);
    if (session) {
      clearTimeout(session.timer);
      await session.context.close();
      this.sessions.delete(id);
    }
  }
  async forget(id) {
    provider(id);
    if (this.pending.has(id))
      throw new ProviderError("Wait for the browser operation to finish.");
    await this.close(id);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }
  async shutdown() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
