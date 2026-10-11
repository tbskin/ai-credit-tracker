import fs from "node:fs";
import { chromium } from "playwright";

const executablePath =
  process.env.STASH_BROWSER_EXECUTABLE ||
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const desktop =
  process.platform !== "linux" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
let browser;
try {
  if (!fs.existsSync(executablePath || chromium.executablePath()))
    throw new Error("The Chromium executable is missing.");
  for (const headless of desktop ? [true, false] : [true]) {
    browser = await chromium.launch({
      headless,
      timeout: 15000,
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage();
    await page.setContent(
      "<title>Stash browser check</title><p>Browser ready.</p>",
    );
    if ((await page.title()) !== "Stash browser check")
      throw new Error("Chromium did not render the test page.");
    await browser.close();
    browser = null;
    console.log(
      `${headless ? "Background refresh" : "Sign-in window"}: ready.`,
    );
  }
  if (!desktop)
    console.log(
      "Sign-in window: not checked. Start a desktop session for provider sign-in.",
    );
} catch {
  console.error(
    "Chromium could not start. Run npm run browser:install with Node.js 22 or 24 LTS.\n" +
      "On Linux, run npx playwright install --with-deps chromium and use a desktop session for sign-in.\n" +
      (executablePath
        ? "A custom browser executable is configured. Check STASH_BROWSER_EXECUTABLE or PLAYWRIGHT_CHROMIUM_EXECUTABLE."
        : "After fixing setup, run npm run browser:check again."),
  );
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
