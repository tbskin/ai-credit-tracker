import test from "node:test";
import assert from "node:assert/strict";
import { aiStatus, chooseCandidate } from "../src/browser/ai.js";
const candidates = [
  { selector: "#wallet", value: "25", context: "Wallet $25" },
  { selector: "#credits", value: "12", context: "Available credits $12" },
];
test("optional AI is off by default and never uses connector credentials", async () => {
  assert.deepEqual(aiStatus({}), { enabled: false });
  let calls = 0;
  await assert.rejects(
    () =>
      chooseCandidate("OpenAI", "USD", candidates, {
        env: {},
        fetcher: () => calls++,
      }),
    /not configured/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(aiStatus({ STASH_AI_MODEL: "example" }), { enabled: false });
  assert.deepEqual(
    aiStatus({
      STASH_AI_MODEL: "example",
      STASH_AI_BASE_URL: "http://remote.example/v1",
      STASH_AI_API_KEY: "secret",
    }),
    { enabled: false },
  );
});
test("AI accepts a candidate ID only, sends bounded visible snippets, and supports a keyless local model", async () => {
  const env = {
    STASH_AI_MODEL: "local-model",
    STASH_AI_BASE_URL: "http://127.0.0.1:11434/v1",
  };
  assert.equal(aiStatus(env).local, true);
  const item = await chooseCandidate("OpenAI", "USD", candidates, {
    env,
    fetcher: async (url, opts) => {
      assert.equal(url, "http://127.0.0.1:11434/v1/chat/completions");
      assert.equal(opts.headers.Authorization, undefined);
      const body = JSON.parse(opts.body);
      assert.equal(body.model, "local-model");
      assert.equal(body.tools, undefined);
      const data = JSON.parse(body.messages[1].content);
      assert.deepEqual(data.candidates, [
        { id: 0, text: "Wallet $25" },
        { id: 1, text: "Available credits $12" },
      ]);
      return Response.json({
        choices: [{ message: { content: '{"candidate_id":1}' } }],
      });
    },
  });
  assert.equal(item, candidates[1]);
  for (const answer of [
    { candidate_id: -1 },
    { candidate_id: 100 },
    { candidate_id: "1" },
    { candidate_id: 0, value: 999 },
    {},
  ]) {
    await assert.rejects(
      () =>
        chooseCandidate("OpenAI", "USD", candidates, {
          env,
          fetcher: async () =>
            Response.json({
              choices: [{ message: { content: JSON.stringify(answer) } }],
            }),
        }),
      /could not identify/,
    );
  }
  await assert.rejects(
    () =>
      chooseCandidate("OpenAI", "USD", candidates, {
        env,
        fetcher: async () =>
          new Response("secret error should not be exposed", { status: 401 }),
      }),
    /could not identify/,
  );
});
