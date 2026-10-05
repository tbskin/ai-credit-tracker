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
    api: false,
    apiLabel: "",
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
    metric: "balance",
  },
  {
    id: "vercel",
    name: "Vercel",
    initial: "▲",
    color: "#23283b",
    category: "Cloud services",
    url: "https://vercel.com/account",
    hosts: ["vercel.com"],
    api: false,
    apiLabel: "",
    metric: "balance",
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
    metric: "balance",
  },
  {
    id: "vercel-gateway",
    name: "Vercel AI Gateway",
    initial: "▲",
    color: "#23283b",
    category: "AI wallets",
    url: "https://vercel.com/dashboard/ai-gateway",
    hosts: ["vercel.com"],
    api: true,
    apiLabel: "AI Gateway API key",
    metric: "balance",
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
async function api(url, token, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
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
export const railwayBalanceQuery = `query StashBalance($id: String!) {
  workspace(workspaceId: $id) { customer { creditBalance } }
}`;
export async function readProvider(id, config, secret, read = api) {
  let value;
  if (id === "openrouter") {
    const { data } = JSON.parse(
      await read("https://openrouter.ai/api/v1/credits", secret),
    );
    value = decimal(data.total_credits).minus(decimal(data.total_usage));
  } else if (id === "vercel-gateway") {
    const data = JSON.parse(
      await read("https://ai-gateway.vercel.sh/v1/credits", secret),
    );
    value = decimal(data.balance);
  } else if (id === "railway") {
    let data;
    if (secret) {
      data = JSON.parse(
        await read("https://backboard.railway.com/graphql/v2", secret, {
          method: "POST",
          body: JSON.stringify({
            query: railwayBalanceQuery,
            variables: { id: config.scope },
          }),
        }),
      );
    } else {
      try {
        const { stdout } = await exec(
          "npx",
          [
            "--yes",
            "--package",
            "@railway/cli@5.63.1",
            "railway",
            "api",
            railwayBalanceQuery,
            "--variables",
            JSON.stringify({ id: config.scope }),
            "--compact",
          ],
          { timeout: 60000, maxBuffer: 2000000 },
        );
        data = JSON.parse(stdout);
      } catch {
        throw new ProviderError(
          "Could not read Railway credits. Check your workspace and token, or run railway login.",
        );
      }
    }
    if (data.errors?.length)
      throw new ProviderError(
        "Railway denied the balance query. Check your account token and workspace.",
      );
    value = decimal(data.data?.workspace?.customer?.creditBalance);
  } else {
    throw new ProviderError(
      "No verified public balance API. Connect with the local browser.",
    );
  }
  return {
    value: value.toString(),
    unit: "USD",
    kind: "balance",
    label: "Credits left",
  };
}
