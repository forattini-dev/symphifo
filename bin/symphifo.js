#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cwd, env, exit, argv, execPath } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "..");
const workspaceRoot = env.SYMPHIFO_WORKSPACE_ROOT ?? cwd();
const cliScript = resolve(packageRoot, "src", "cli.ts");

const child = spawn(execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cliScript, ...argv.slice(2)], {
  cwd: workspaceRoot,
  stdio: "inherit",
  env: {
    ...env,
    SYMPHIFO_WORKSPACE_ROOT: workspaceRoot,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start symphifo CLI: ${String(error)}`);
  exit(1);
});
