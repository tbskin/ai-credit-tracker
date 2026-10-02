import { ProviderError } from "../src/providers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-e2e-"));
const app = createApp({
  dir,
  port: 4748,
  reader: async (id, config, key) => {
    if (key === "rejected")
      throw new ProviderError("Key rejected. Reconnect with a valid key.");
    return {
      value: "42.5",
      unit: "USD",
      kind: id === "openrouter" ? "balance" : "spend",
      label: id === "openrouter" ? "Credit balance" : "Spent this month",
      detail: "Test fixture",
    };
  },
});
await app.listen();
process.on("SIGTERM", () => {
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit();
});
