import { ProviderError } from "../src/providers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-e2e-"));
const sessions = new Map();
const browser = {
  isOpen: (id) => sessions.has(id),
  open: async (id, config, capture) => sessions.set(id, { config, capture }),
  find: async () => {},
  select: async (id) => {
    const { config, capture } = sessions.get(id);
    await capture({
      url: config.url,
      selector: "#balance",
      fingerprint: "Credits #",
      value: "19.75",
    });
  },
  close: async (id) => sessions.delete(id),
  forget: async (id) => sessions.delete(id),
  shutdown: async () => sessions.clear(),
  read: async () => ({
    value: "18.5",
    unit: "USD",
    kind: "balance",
    label: "Credits left",
  }),
};
const app = createApp({
  browser,
  dir,
  port: 4748,
  reader: async (id, config, key) => {
    if (key === "rejected")
      throw new ProviderError("Key rejected. Reconnect with a valid key.");
    return {
      value: "42.5",
      unit: "USD",
      kind: "balance",
      label: "Credits left",
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
