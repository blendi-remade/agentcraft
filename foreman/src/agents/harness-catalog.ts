import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { CodexAppServer } from "./codex/app-server.js";
import { codexCommand } from "./codex/launch.js";
import { modelChoices, type ModelChoice } from "./codex/model-settings.js";
import {
  detectApiAuth,
  withAuthMode,
  NO_API_AUTH_MESSAGE,
} from "./claude/auth.js";

export type HarnessName = "codex" | "claude";
export interface HarnessCapability {
  provider: HarnessName;
  installed: boolean;
  available: boolean;
  version?: string;
  binaryPath?: string;
  auth?: "login" | "api";
  reason?: string;
  models: ModelChoice[];
}
function executable(name: string, explicit?: string): string | undefined {
  const names =
    process.platform === "win32"
      ? [`${name}.exe`, `${name}.cmd`, name]
      : [name];
  // An explicitly selected runtime must never silently fall back to another installation.
  const candidates = explicit
    ? [explicit]
    : [
        ...(process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .flatMap((dir) => names.map((n) => path.join(dir, n))),
        path.join(os.homedir(), ".local", "bin", name),
      ];
  return candidates.find((file): file is string => {
    if (!file) return false;
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}
function run(
  command: string,
  args: string[],
): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) =>
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 32 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) =>
        resolve({ ok: !error, text: `${stdout}\n${stderr}` }),
    ),
  );
}

/** Detection is read-only and never changes logins, user settings, or running agents. */
export function createHarnessCatalog(config: Config) {
  const cached = new Map<
    HarnessName,
    { at: number; value: HarnessCapability }
  >();
  const pending = new Map<HarnessName, Promise<HarnessCapability>>();
  async function inspect(provider: HarnessName): Promise<HarnessCapability> {
    const binary = executable(
      provider,
      provider === "codex"
        ? (config.codex.binaryPath ?? process.env.CODEX_CLI_PATH)
        : undefined,
    );
    if (!binary && provider === "codex")
      return {
        provider,
        installed: false,
        available: false,
        models: [],
        reason: `Install the standalone ${provider === "codex" ? "Codex" : "Claude Code"} CLI to use this harness.`,
      };
    let version: string | undefined = binary
      ? undefined
      : "Claude Agent SDK bundled CLI";
    try {
      // Codex npm shims have a shell-free invocation; Claude catalog uses its SDK transport.
      if (
        binary &&
        (provider === "codex" || !binary.toLowerCase().endsWith(".cmd"))
      ) {
        const invocation =
          provider === "codex"
            ? codexCommand(binary, ["--version"])
            : { command: binary, args: ["--version"] };
        const result = await run(invocation.command, invocation.args);
        if (result.ok)
          version = result.text.trim().split("\n")[0]?.slice(0, 100);
      }
      if (provider === "codex") {
        if (!binary) throw new Error("Codex executable is unavailable");
        const invocation = codexCommand(binary, ["login", "status"]);
        const login = await run(invocation.command, invocation.args);
        if (!login.ok)
          return {
            provider,
            installed: true,
            available: false,
            version,
            models: [],
            reason: "Run codex login, then detect again.",
          };
        const server = new CodexAppServer({
          binaryPath: binary,
          cwd: os.tmpdir(),
          env: process.env,
          onNotification: () => {},
          onServerRequest: async () => {
            throw new Error("No active agent turn");
          },
        });
        try {
          await server.start();
          const models: ModelChoice[] = [];
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const result = (await server.request("model/list", {
              limit: 100,
              ...(cursor ? { cursor } : {}),
            })) as {
              data: unknown;
              nextCursor?: string;
            };
            models.push(...modelChoices(result.data));
            cursor = result.nextCursor || undefined;
            if (cursor && (seen.has(cursor) || seen.size >= 20))
              throw new Error("Invalid model catalog pagination");
            if (cursor) seen.add(cursor);
          } while (cursor);
          return {
            provider,
            installed: true,
            available: models.length > 0,
            version,
            binaryPath: binary,
            auth: /api key/i.test(login.text) ? "api" : "login",
            models,
            ...(!models.length
              ? { reason: "The CLI returned no selectable models." }
              : {}),
          };
        } finally {
          await server.close();
        }
      }
      const auth = config.claude.useClaudeLogin ? "login" : "api";
      if (auth === "api" && !detectApiAuth(process.env).ok) {
        return {
          provider,
          installed: true,
          available: false,
          version,
          auth,
          models: [],
          reason: NO_API_AUTH_MESSAGE,
        };
      }
      const controller = new AbortController();
      async function* input(): AsyncGenerator<never> {
        await new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      }
      const q = query({
        prompt: input(),
        options: {
          ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
          settingSources: [],
          persistSession: false,
          tools: [],
          mcpServers: {},
          permissionMode: "default",
          env: withAuthMode(process.env, auth === "login"),
          abortController: controller,
        },
      });
      let timer: NodeJS.Timeout | undefined;
      try {
        const info = await Promise.race([
          Promise.all([q.accountInfo(), q.supportedModels()]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Claude discovery timed out")),
              30_000,
            );
          }),
        ]);
        const [account, catalog] = info;
        const authenticated = !!(
          account.email ||
          account.organization ||
          (account.tokenSource && account.tokenSource !== "none") ||
          (account.apiKeySource && account.apiKeySource !== "none") ||
          (account.apiProvider && account.apiProvider !== "firstParty")
        );
        if (!authenticated)
          return {
            provider,
            installed: true,
            available: false,
            version,
            models: [],
            reason: "Sign in with Claude Code, then detect again.",
          };
        const models = catalog.map((m) => ({
          model: m.value,
          label: m.displayName,
          efforts: [
            "default",
            ...(m.supportsEffort === false
              ? []
              : (m.supportedEffortLevels ?? [])),
          ],
          defaultEffort: "default",
        }));
        return {
          provider,
          installed: true,
          available: models.length > 0,
          version,
          binaryPath: binary,
          auth,
          models,
        };
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
        q.close();
      }
    } catch {
      return {
        provider,
        installed: true,
        available: false,
        version,
        models: [],
        reason: `Could not query ${provider === "codex" ? "Codex" : "Claude Code"}. Check that its CLI starts correctly, then retry detection.`,
      };
    }
  }
  return async (
    provider: HarnessName,
    refresh = false,
  ): Promise<HarnessCapability> => {
    const previous = cached.get(provider);
    if (!refresh && previous && Date.now() - previous.at < 30_000)
      return previous.value;
    const running = pending.get(provider);
    if (running) return running;
    const result = inspect(provider)
      .then((value) => {
        cached.set(provider, { at: Date.now(), value });
        return value;
      })
      .finally(() => pending.delete(provider));
    pending.set(provider, result);
    return result;
  };
}
