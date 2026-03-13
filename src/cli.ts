import { spawn } from "node:child_process";
import { cwd, env, execPath, exit, kill, pid } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createCLI, type CommandParseResult } from "cli-args-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
  name?: string;
  version?: string;
  description?: string;
};
const runtimeScript = resolve(packageRoot, "src", "runtime", "run-local.ts");
const mcpScript = resolve(packageRoot, "src", "mcp", "server.ts");
const tsxCli = require.resolve("tsx/cli");

const commonOptions = {
  workspace: {
    type: "string",
    description: "Target workspace root. Defaults to the current directory.",
  },
  persistence: {
    type: "string",
    description: "Persistence root. Defaults to the current directory.",
  },
  port: {
    type: "number",
    description: "Start the local API/dashboard on the provided port.",
  },
  concurrency: {
    type: "number",
    description: "Maximum number of concurrent workers.",
  },
  attempts: {
    type: "number",
    description: "Maximum attempts per issue.",
  },
  poll: {
    type: "number",
    description: "Scheduler interval in milliseconds.",
  },
  once: {
    type: "boolean",
    description: "Process one scheduler cycle and exit.",
    default: false,
  },
} as const;

function getStringOption(result: CommandParseResult, key: keyof typeof commonOptions): string | undefined {
  const value = result.options[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getNumberOption(result: CommandParseResult, key: keyof typeof commonOptions): number | undefined {
  const value = result.options[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getBooleanOption(result: CommandParseResult, key: keyof typeof commonOptions): boolean {
  return result.options[key] === true;
}

function buildRuntimeArgs(result: CommandParseResult): string[] {
  const runtimeArgs: string[] = [];
  const workspace = getStringOption(result, "workspace");
  const persistence = getStringOption(result, "persistence");
  const port = getNumberOption(result, "port");
  const concurrency = getNumberOption(result, "concurrency");
  const attempts = getNumberOption(result, "attempts");
  const poll = getNumberOption(result, "poll");

  if (workspace) {
    runtimeArgs.push("--workspace", workspace);
  }
  if (persistence) {
    runtimeArgs.push("--persistence", persistence);
  }
  if (typeof port === "number") {
    runtimeArgs.push("--port", String(port));
  }
  if (typeof concurrency === "number") {
    runtimeArgs.push("--concurrency", String(concurrency));
  }
  if (typeof attempts === "number") {
    runtimeArgs.push("--attempts", String(attempts));
  }
  if (typeof poll === "number") {
    runtimeArgs.push("--poll", String(poll));
  }
  if (getBooleanOption(result, "once")) {
    runtimeArgs.push("--once");
  }

  return runtimeArgs;
}

async function runRuntime(mode: "cli" | "mcp", result: CommandParseResult): Promise<void> {
  const workspace = getStringOption(result, "workspace");
  const workspaceRoot = resolve(workspace ?? env.SYMPHIFO_WORKSPACE_ROOT ?? cwd());
  const runtimeArgs = buildRuntimeArgs(result);

  const outcome = await new Promise<{ code?: number | null; signal?: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
    const child = spawn(execPath, [tsxCli, runtimeScript, ...runtimeArgs], {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: {
        ...env,
        SYMPHIFO_INTERFACE: mode,
        SYMPHIFO_WORKSPACE_ROOT: workspaceRoot,
      },
    });

    child.on("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });
  });

  if (outcome.signal) {
    kill(pid, outcome.signal);
    return;
  }

  if (typeof outcome.code === "number" && outcome.code !== 0) {
    exit(outcome.code);
  }
}

async function runMcpServer(result: CommandParseResult): Promise<void> {
  const workspace = getStringOption(result, "workspace");
  const persistence = getStringOption(result, "persistence");
  const workspaceRoot = resolve(workspace ?? env.SYMPHIFO_WORKSPACE_ROOT ?? cwd());
  const persistenceRoot = resolve(persistence ?? env.SYMPHIFO_PERSISTENCE ?? workspaceRoot);

  const outcome = await new Promise<{ code?: number | null; signal?: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
    const child = spawn(execPath, [tsxCli, mcpScript], {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: {
        ...env,
        SYMPHIFO_WORKSPACE_ROOT: workspaceRoot,
        SYMPHIFO_PERSISTENCE: persistenceRoot,
      },
    });

    child.on("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });
  });

  if (outcome.signal) {
    kill(pid, outcome.signal);
    return;
  }

  if (typeof outcome.code === "number" && outcome.code !== 0) {
    exit(outcome.code);
  }
}

const cli = createCLI({
  name: packageJson.name ?? "symphifo",
  version: packageJson.version ?? "0.0.0",
  description: packageJson.description ?? "Filesystem-backed local multi-agent orchestrator.",
  commands: {
    run: {
      description: "Run the local Symphifo runtime with the dashboard/API enabled when --port is provided.",
      options: commonOptions,
      handler: (result) => runRuntime("cli", result),
    },
    mcp: {
      description: "Run a Symphifo MCP server over stdio with resources, tools, and prompts backed by the local durable store.",
      options: commonOptions,
      handler: (result) => runMcpServer(result),
    },
  },
});

function normalizeArgs(rawArgs: string[]): string[] {
  if (rawArgs.length === 0) {
    return ["run"];
  }

  const first = rawArgs[0];
  if (["--help", "-h", "help", "--version", "-v", "version"].includes(first)) {
    return rawArgs;
  }

  if (first.startsWith("-")) {
    return ["run", ...rawArgs];
  }

  return rawArgs;
}

const args = normalizeArgs(process.argv.slice(2));

cli.run(args).catch((error) => {
  console.error(`Failed to start symphifo CLI: ${String(error)}`);
  exit(1);
});
