// Conservative label rules, not claims about a provider's current DOM structure.
// Unknown layouts and multiple wallets always need a user selection.
export const balanceLabels = {
  openai: [
    "credit balance",
    "remaining balance",
    "prepaid balance",
    "available balance",
  ],
  openrouter: [
    "credit balance",
    "credits remaining",
    "remaining credits",
    "available credits",
  ],
  higgsfield: [
    "api balance",
    "api credits",
    "credit balance",
    "credits remaining",
    "remaining credits",
    "available credits",
  ],
  railway: ["credit balance", "unused credits", "remaining credits"],
  vercel: ["credit balance", "prepaid balance", "remaining credits"],
  supabase: [
    "credit balance",
    "credits balance",
    "remaining credits",
    "available credits",
  ],
  "vercel-gateway": [
    "credit balance",
    "remaining balance",
    "remaining credits",
    "available credits",
  ],
};
