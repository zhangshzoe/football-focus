import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { signContextProof } from "../app/context-evidence.js";

const routeUrl = new URL("../app/api/analyze/route.ts", import.meta.url);
const typescript = createRequire(import.meta.url)("typescript");
const compiled = typescript.transpileModule(await readFile(routeUrl, "utf8"), {
  compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022 },
}).outputText.replace('"../../context-evidence.js"', JSON.stringify(new URL("../app/context-evidence.js", import.meta.url).href));
const { POST } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const secret = "analyze-test-signing-key";
const legacyInput = () => ({
  match: { id: "001", home: "h", away: "a", officialMappingStatus: "verified" },
  odds: { 胜平负: [{ label: "胜", odd: 1.1 }] },
  knownFactors: { injuries: "客户声称全部健康", recentForm: "虚构十连胜" },
  probabilities: { home: 99, draw: 1, away: 0 },
});
const request = body => new Request("http://localhost/api/analyze", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

async function scoped(run, fetcher, apiKey = "test-api-key") {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalSigning = process.env.MATCH_CONTEXT_SIGNING_KEY;
  if (apiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = apiKey;
  process.env.MATCH_CONTEXT_SIGNING_KEY = secret;
  globalThis.fetch = fetcher || (() => { throw new Error("Unexpected network request"); });
  try { return await run(); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    if (originalSigning === undefined) delete process.env.MATCH_CONTEXT_SIGNING_KEY;
    else process.env.MATCH_CONTEXT_SIGNING_KEY = originalSigning;
  }
}

async function signedReport() {
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const report = {
    id: "001", predictionId: "frozen-p", inputSnapshotId: "frozen-i",
    officialMatchId: "123", officialMappingStatus: "verified", home: "h", away: "a",
    kickoffAt: new Date(Date.now() + 3_600_000).toISOString(),
    probabilities: { home: 99, draw: 1, away: 0 },
    modelInput: { matchContext: {
      status: "partial", observedAt, missing: ["非点球xG资料缺失"],
      injuries: [{ side: "home", player: "已核验球员", personId: "p1", injuryFlag: 1,
        replacementImpact: null, sourceUrl: "https://www.sporttery.cn/injury", observedAt }],
      lineup: { home: [{ personId: "p1" }], away: [],
        sourceUrl: "https://www.sporttery.cn/lineup", observedAt },
      oddsTimeline: [{ sourceUrl: "https://www.sporttery.cn/odds", observedAt }],
    } },
  };
  report.contextProof = await signContextProof(report, secret);
  return report;
}

test("legacy page payload keeps text compatibility but cannot turn arbitrary fields into official evidence", async () => {
  await scoped(async () => {
    const response = await POST(request(legacyInput()));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Cache-Control"), /no-store/);
    const data = await response.json();
    assert.equal(typeof data.text, "string");
    assert.equal(data.reviewMode, "evidence-summary-v1");
    assert.equal(data.contextStatus, "unverified");
    assert.equal(data.intelligenceWeightMultiplier, 0);
    assert.match(data.text, /可信来源与实际观测时间缺失/);
    assert.match(data.text, /伤停资料缺失/);
    assert.match(data.text, /首发与实际出场状态资料缺失/);
    assert.match(data.text, /天气、场地与裁判信息缺少可信来源/);
    assert.doesNotMatch(data.text, /全部健康|虚构十连胜|99%|1\.1/);
    assert.equal(data.probabilities, undefined);
  });
});

test("missing AI configuration still returns an honest local missing-data summary", async () => {
  await scoped(async () => {
    const response = await POST(request(legacyInput()));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.provider, "服务器证据整理");
    assert.match(data.text, /没有可验证的赛前事实/);
  }, undefined, "");
});

test("signed evidence prompt bans new probabilities and returned text ignores LLM invented content", async () => {
  const report = await signedReport();
  let calls = 0;
  await scoped(async () => {
    const response = await POST(request({ ...legacyInput(), report }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(calls, 1);
    assert.equal(data.provider, "DeepSeek");
    assert.equal(data.model, "stub-evidence-model");
    assert.equal(data.contextStatus, "verified-frozen-context");
    assert.match(data.text, /已核验球员/);
    assert.match(data.text, /https:\/\/www\.sporttery\.cn\/injury/);
    assert.ok(data.text.includes(report.modelInput.matchContext.observedAt));
    assert.match(data.text, /伤停记录与首发列表出现同一球员/);
    assert.match(data.text, /非点球xG资料缺失/);
    assert.match(data.text, /核验球员出场状态及替补影响/);
    assert.doesNotMatch(data.text, /必胜|80%|比分2:1|胜胜建议|虚构十连胜|99%/);
  }, async (url, options) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    const payload = JSON.parse(options.body);
    assert.equal(payload.response_format.type, "json_object");
    const prompt = payload.messages.map(message => message.content).join("\n");
    assert.match(prompt, /禁止生成、估计、调整或输出胜平负、让球、总进球、比分、半全场的预测概率/);
    assert.match(prompt, /禁止比分或半全场候选/);
    assert.match(prompt, /不新增联网查询或猜测/);
    assert.match(prompt, /同一来源的多个接口不是独立证据/);
    assert.doesNotMatch(prompt, /客户声称全部健康|虚构十连胜|"probabilities"|"home":99/);
    return Response.json({ model: "stub-evidence-model", choices: [{ message: { content: JSON.stringify({
      reviews: [{ id: "001", facts: [{ text: "必胜80%，比分2:1，胜胜建议", evidenceIds: ["e1"] }],
        conflicts: [], checks: [{ text: "同样必胜80%", evidenceIds: ["e1"] }],
        probabilities: [80, 10, 10] }],
    }) } }] });
  });
});

test("tampered frozen context is downgraded without a network request or invented evidence", async () => {
  const report = await signedReport();
  report.modelInput.matchContext.injuries[0].player = "伪造新球员";
  await scoped(async () => {
    const response = await POST(request({ report }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.contextStatus, "unverified");
    assert.doesNotMatch(data.text, /伪造新球员|sporttery\.cn\/injury/);
  });
});

test("unsupported LLM evidence references are rejected instead of returning free-form analysis", async () => {
  const report = await signedReport();
  await scoped(async () => {
    const response = await POST(request({ report }));
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.text, undefined);
    assert.match(data.error, /未输出未经核验/);
  }, async () => Response.json({ choices: [{ message: { content: JSON.stringify({
    reviews: [{ id: "001", facts: [{ text: "编造", evidenceIds: ["e999"] }], conflicts: [], checks: [] }],
  }) } }] }));
});

test("invalid JSON, absent match, array and oversized input preserve client-error responses", async () => {
  await scoped(async () => {
    for (const body of [{}, null, { match: [] }, { match: {}, extra: "x".repeat(30_001) }]) {
      assert.equal((await POST(request(body))).status, 400);
    }
    assert.equal((await POST(new Request("http://localhost/api/analyze", { method: "POST", body: "{" }))).status, 400);
  });
});
