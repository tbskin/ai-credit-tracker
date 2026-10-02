import Decimal from "decimal.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export class ProviderError extends Error {}
export const providers = [
  {
    id: "openrouter",
    name: "OpenRouter",
    initial: "OR",
    color: "#5662d3",
    category: "AI wallets",
    url: "https://openrouter.ai/settings/credits",
    hosts: ["openrouter.ai"],
    api: true,
    apiLabel: "Management key",
    metric: "balance",
  },
  {
    id: "openai",
    name: "OpenAI",
    initial: "O",
    color: "#17846b",
    category: "AI wallets",
    url: "https://platform.openai.com/settings/organization/billing/overview",
    hosts: ["platform.openai.com"],
    api: true,
    apiLabel: "Organization admin key",
    metric: "balance",
  },
  {
    id: "higgsfield",
    name: "Higgsfield",
    initial: "H",
    color: "#9d6429",
    category: "AI wallets",
    url: "https://console.higgsfield.ai",
    hosts: [
      "console.higgsfield.ai",
      "cloud.higgsfield.ai",
      "open.higgsfield.ai",
    ],
    api: false,
    metric: "balance",
  },
  {
    id: "railway",
    name: "Railway",
    initial: "R",
    color: "#713ab2",
    category: "Cloud services",
    url: "https://railway.com",
    hosts: ["railway.com", "railway.app"],
    api: true,
    apiLabel: "Railway account token (or existing CLI login)",
    metric: "spend",
  },
  {
    id: "vercel",
    name: "Vercel",
    initial: "▲",
    color: "#23283b",
    category: "Cloud services",
    url: "https://vercel.com/account",
    hosts: ["vercel.com"],
    api: true,
    apiLabel: "Access token",
    metric: "spend",
  },
  {
    id: "supabase",
    name: "Supabase",
    initial: "S",
    color: "#24885e",
    category: "Cloud services",
    url: "https://supabase.com/dashboard",
    hosts: ["supabase.com"],
    api: false,
    metric: "spend",
  },
];
export function provider(id) {
  const p = providers.find((p) => p.id === id);
  if (!p) throw new ProviderError("Unknown provider.");
  return p;
}
export function validPage(id, url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      provider(id).hosts.includes(u.hostname)
    );
  } catch {
    return false;
  }
}
export function decimal(value) {
  if (value === null || value === undefined || typeof value === "boolean")
    throw new ProviderError("Missing amount.");
  const n = new Decimal(value);
  if (!n.isFinite()) throw new ProviderError("Invalid amount.");
  return n;
}
async function api(url, token) {
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ProviderError("Could not reach provider. Retry shortly.");
  }
  if (!response.ok)
    throw new ProviderError(
      response.status === 401
        ? "Key rejected. Reconnect with a valid key."
        : response.status === 403
          ? "This key cannot read billing. Check its permissions."
          : response.status === 429
            ? "Provider rate limit reached. Try again later."
            : `Provider returned HTTP ${response.status}.`,
    );
  const text = await response.text();
  if (text.length > 20000000)
    throw new ProviderError("Billing response too large.");
  return text;
}
export async function readProvider(id, config, secret, read = api) {
  const now = new Date(),
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (id === "openrouter") {
    const { data } = JSON.parse(
      await read("https://openrouter.ai/api/v1/credits", secret),
    );
    return {
      value: decimal(data.total_credits)
        .minus(decimal(data.total_usage))
        .toString(),
      unit: "USD",
      kind: "balance",
      label: "Credit balance",
      detail: "Purchased credits less reported usage",
    };
  }
  if (id === "openai") {
    let total = new Decimal(0),
      cursor,
      seen = new Set();
    for (let count = 0; count < 100; count++) {
      const q = new URLSearchParams({
        start_time: Math.floor(start / 1000),
        end_time: Math.floor(now / 1000),
        limit: 180,
      });
      if (cursor) q.set("page", cursor);
      const page = JSON.parse(
        await read(`https://api.openai.com/v1/organization/costs?${q}`, secret),
      );
      for (const bucket of page.data)
        for (const row of bucket.results) {
          if (row.amount?.currency !== "usd")
            throw new ProviderError("Unsupported or missing billing currency.");
          total = total.plus(decimal(row.amount.value));
        }
      if (page.has_more === false)
        return {
          value: total.toString(),
          unit: "USD",
          kind: "spend",
          label: "Spent this month",
          detail: "Calendar month · UTC · not wallet balance",
          period: { start: start.toISOString(), end: now.toISOString() },
        };
      cursor = page.next_page;
      if (!cursor || seen.has(cursor))
        throw new ProviderError("Incomplete billing response.");
      seen.add(cursor);
    }
    throw new ProviderError("Incomplete billing response.");
  }
  if (id === "vercel") {
    const q = new URLSearchParams({
      teamId: config.scope,
      from: start.toISOString(),
      to: now.toISOString(),
    });
    const text = await read(
      `https://api.vercel.com/v1/billing/charges?${q}`,
      secret,
    );
    let total = new Decimal(0),
      rows = 0;
    for (const line of text.split("\n").filter((l) => l.trim())) {
      const row = JSON.parse(line);
      if (row.BillingCurrency !== "USD")
        throw new ProviderError("Unsupported or missing billing currency.");
      total = total.plus(decimal(row.BilledCost));
      rows++;
    }
    if (!rows)
      throw new ProviderError(
        "No billing rows reported yet. Try again after usage is available.",
      );
    return {
      value: total.toString(),
      unit: "USD",
      kind: "spend",
      label: "Billed cost this month",
      detail: "Calendar month · UTC · provider reporting may lag",
      period: { start: start.toISOString(), end: now.toISOString() },
    };
  }
  if (id === "railway") {
    let stdout;
    try {
      ({ stdout } = await exec(
        "npx",
        [
          "--yes",
          "--package",
          "@railway/cli@5.63.1",
          "railway",
          "usage",
          "--workspace",
          config.scope,
          "--json",
        ],
        {
          timeout: 90000,
          maxBuffer: 2000000,
          env: {
            ...process.env,
            ...(secret ? { RAILWAY_API_TOKEN: secret } : {}),
          },
        },
      ));
    } catch {
      throw new ProviderError(
        "Railway could not read usage. Check your workspace ID and account token or run railway login.",
      );
    }
    const data = JSON.parse(stdout);
    return {
      value: decimal(data.currentUsageDollars).toString(),
      unit: "USD",
      kind: "spend",
      label: "Used this billing period",
      detail:
        data.estimatedBillDollars == null
          ? "Estimate unavailable"
          : `Estimated bill $${decimal(data.estimatedBillDollars).toFixed(2)}`,
      period: data.billingPeriod,
    };
  }
  throw new ProviderError("Connect this provider with the browser extension.");
}
