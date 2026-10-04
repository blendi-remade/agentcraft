import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { createHarnessCatalog } from "../src/agents/harness-catalog.js";

const fake = vi.hoisted(() => ({
  installed: true,
  login: true,
  missingPath: undefined as string | undefined,
  request: vi.fn(),
  close: vi.fn(),
  start: vi.fn(),
  query: vi.fn(),
  accountInfo: vi.fn(),
  supportedModels: vi.fn(),
  claudeClose: vi.fn(),
  exec: vi.fn(),
}));
vi.mock("node:fs", () => ({
  default: {
    statSync: (file: string) => {
      if (!fake.installed || file === fake.missingPath)
        throw new Error("missing");
      return { isFile: () => true };
    },
  },
}));
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => fake.exec(...args),
}));
vi.mock("../src/agents/codex/app-server.js", () => ({
  CodexAppServer: class {
    start = fake.start;
    request = fake.request;
    close = fake.close;
  },
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => {
    fake.query(args);
    return {
      accountInfo: fake.accountInfo,
      supportedModels: fake.supportedModels,
      close: fake.claudeClose,
    };
  },
}));

const config = {
  codex: { binaryPath: "/tools/codex" },
  claude: { useClaudeLogin: true },
} as Config;
beforeEach(() => {
  vi.clearAllMocks();
  fake.installed = true;
  fake.login = true;
  fake.missingPath = undefined;
  vi.stubEnv("PATH", "/tools");
  fake.exec.mockImplementation((_command, args, _options, callback) => {
    const auth = args[0] === "login";
    callback(
      auth && !fake.login ? new Error("not logged in") : null,
      auth ? "Logged in using ChatGPT" : "test-cli 1.0",
      "",
    );
  });
  fake.request.mockResolvedValue({
    data: [
      {
        id: "m",
        model: "gpt-test",
        displayName: "GPT Test",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        defaultReasoningEffort: "high",
      },
    ],
  });
  fake.accountInfo.mockResolvedValue({ tokenSource: "login" });
  fake.supportedModels.mockResolvedValue([
    {
      value: "sonnet",
      displayName: "Sonnet",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    },
    { value: "haiku", displayName: "Haiku", supportsEffort: false },
  ]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("deduplicates concurrent detection and caches successful results until refreshed", async () => {
  const detect = createHarnessCatalog(config);
  const [first, second] = await Promise.all([detect("codex"), detect("codex")]);
  expect(first).toBe(second);
  expect(first).toMatchObject({
    available: true,
    binaryPath: "/tools/codex",
    auth: "login",
  });
  expect(fake.start).toHaveBeenCalledTimes(1);
  expect(await detect("codex")).toBe(first);
  await detect("codex", true);
  expect(fake.start).toHaveBeenCalledTimes(2);
  expect(fake.close).toHaveBeenCalledTimes(2);
});
it("does not start a catalog process when the CLI is absent or logged out", async () => {
  fake.installed = false;
  expect(await createHarnessCatalog(config)("codex")).toMatchObject({
    installed: false,
    available: false,
    models: [],
  });
  fake.installed = true;
  fake.login = false;
  expect(await createHarnessCatalog(config)("codex")).toMatchObject({
    installed: true,
    available: false,
    models: [],
  });
  expect(fake.start).not.toHaveBeenCalled();
});
it("closes a failed Codex catalog and rejects repeated pagination cursors", async () => {
  fake.request.mockResolvedValue({ data: [], nextCursor: "repeat" });
  expect(await createHarnessCatalog(config)("codex")).toMatchObject({
    available: false,
  });
  expect(fake.request).toHaveBeenCalledTimes(2);
  expect(fake.close).toHaveBeenCalledOnce();
});
it("queries the detected Claude executable without a prompt, saved session, or tools", async () => {
  const result = await createHarnessCatalog(config)("claude");
  expect(result).toMatchObject({
    available: true,
    binaryPath: "/tools/claude",
    auth: "login",
  });
  expect(result.models).toEqual([
    {
      model: "sonnet",
      label: "Sonnet",
      efforts: ["default", "low", "high"],
      defaultEffort: "default",
    },
    {
      model: "haiku",
      label: "Haiku",
      efforts: ["default"],
      defaultEffort: "default",
    },
  ]);
  const args = fake.query.mock.calls[0]![0];
  expect(args.options).toMatchObject({
    pathToClaudeCodeExecutable: "/tools/claude",
    persistSession: false,
    tools: [],
    mcpServers: {},
    settingSources: [],
  });
  expect(typeof args.prompt[Symbol.asyncIterator]).toBe("function");
  expect(args.options.abortController.signal.aborted).toBe(true);
  expect(fake.claudeClose).toHaveBeenCalledOnce();
});
it("does not expose account details or raw errors when Claude discovery fails", async () => {
  fake.accountInfo.mockRejectedValue(new Error("secret credential detail"));
  const result = await createHarnessCatalog(config)("claude");
  expect(result.available).toBe(false);
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(result.reason).not.toMatch(/auth|login|credential|sign.in/i);
  expect(fake.claudeClose).toHaveBeenCalledOnce();
});
it("requires actual authentication even if Claude returns a model list", async () => {
  fake.accountInfo.mockResolvedValue({
    tokenSource: "none",
    apiKeySource: "none",
  });
  expect(await createHarnessCatalog(config)("claude")).toMatchObject({
    available: false,
    models: [],
  });
});
it("cancels a stalled Claude discovery and closes the transport", async () => {
  vi.useFakeTimers();
  fake.accountInfo.mockReturnValue(new Promise(() => {}));
  const result = createHarnessCatalog(config)("claude");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toMatchObject({ available: false });
  expect(fake.claudeClose).toHaveBeenCalledOnce();
  expect(
    fake.query.mock.calls[0]![0].options.abortController.signal.aborted,
  ).toBe(true);
});

it("never substitutes a different CLI when an explicitly configured binary is missing", async () => {
  fake.missingPath = "/tools/codex";
  expect(await createHarnessCatalog(config)("codex")).toMatchObject({
    installed: false,
    available: false,
  });
  expect(fake.exec).not.toHaveBeenCalled();
});

it("does not use an existing subscription login without the host opt-in", async () => {
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  ])
    vi.stubEnv(key, "");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fixture-personal-login");
  const result = await createHarnessCatalog({
    ...config,
    claude: { ...config.claude, useClaudeLogin: false },
  })("claude");
  expect(result).toMatchObject({ available: false, auth: "api", models: [] });
  expect(result.reason).toContain("--use-claude-login");
  expect(fake.query).not.toHaveBeenCalled();
});
it("retains SDK-bundled Claude execution for API users without a global CLI", async () => {
  fake.installed = false;
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-api-key");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fixture-personal-login");
  fake.accountInfo.mockResolvedValue({ apiKeySource: "environment" });
  const result = await createHarnessCatalog({
    ...config,
    claude: { ...config.claude, useClaudeLogin: false },
  })("claude");
  expect(result).toMatchObject({
    available: true,
    auth: "api",
    version: "Claude Agent SDK bundled CLI",
  });
  expect(result.binaryPath).toBeUndefined();
  const options = fake.query.mock.calls[0]![0].options;
  expect(options).not.toHaveProperty("pathToClaudeCodeExecutable");
  expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(options.env.ANTHROPIC_API_KEY).toBe("fixture-api-key");
  expect(fake.exec).not.toHaveBeenCalled();
  expect(fake.claudeClose).toHaveBeenCalledOnce();
});
