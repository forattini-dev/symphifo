#!/usr/bin/env node
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { env, exit, argv, cwd as getCwd } from "node:process";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

type JsonRecord = Record<string, unknown>;

type IssueState =
  | "Todo"
  | "In Progress"
  | "In Review"
  | "Blocked"
  | "Done"
  | "Cancelled";

type RuntimeEventType =
  | "info"
  | "state"
  | "progress"
  | "error"
  | "manual"
  | "runner";

type RuntimeEvent = {
  id: string;
  issueId?: string;
  kind: RuntimeEventType;
  message: string;
  at: string;
};

type IssueEntry = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  state: IssueState;
  branchName?: string;
  url?: string;
  assigneeId?: string;
  labels: string[];
  blockedBy: string[];
  assignedToWorker: boolean;
  createdAt: string;
  updatedAt: string;
  history: string[];
  startedAt?: string;
  completedAt?: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: string;
  workspacePath?: string;
  workspacePreparedAt?: string;
  lastError?: string;
  durationMs?: number;
  commandExitCode?: number | null;
  commandOutputTail?: string;
};

type RuntimeConfig = {
  pollIntervalMs: number;
  workerConcurrency: number;
  commandTimeoutMs: number;
  maxAttemptsDefault: number;
  maxTurns: number;
  retryDelayMs: number;
  staleInProgressTimeoutMs: number;
  logLinesTail: number;
  agentProvider: string;
  agentCommand: string;
  dashboardPort?: string;
  runMode: "filesystem";
};

type RuntimeMetrics = {
  total: number;
  queued: number;
  inProgress: number;
  blocked: number;
  done: number;
  cancelled: number;
  activeWorkers: number;
};

type RuntimeState = {
  startedAt: string;
  updatedAt: string;
  trackerKind: "filesystem";
  sourceRepoUrl: string;
  sourceRef: string;
  workflowPath: string;
  dashboardPort?: string;
  config: RuntimeConfig;
  issues: IssueEntry[];
  events: RuntimeEvent[];
  metrics: RuntimeMetrics;
  notes: string[];
};

type RuntimeStateRecord = {
  id: string;
  schemaVersion: number;
  trackerKind: RuntimeState["trackerKind"];
  runtimeTag: string;
  updatedAt: string;
  state: RuntimeState;
};

type AgentSessionRecord = {
  id: string;
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  cycle: number;
  provider: string;
  role: AgentProviderRole;
  updatedAt: string;
  session: AgentSessionState;
};

type AgentPipelineRecord = {
  id: string;
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  updatedAt: string;
  pipeline: AgentPipelineState;
};

type IssueRecord = IssueEntry;
type EventRecord = RuntimeEvent;

type WorkflowDefinition = {
  workflowPath: string;
  rendered: string;
  config: JsonRecord;
  promptTemplate: string;
  agentProvider: string;
  agentProfile: string;
  agentProfilePath: string;
  agentProfileInstructions: string;
  agentProviders: AgentProviderDefinition[];
  afterCreateHook: string;
  beforeRunHook: string;
  afterRunHook: string;
};

type AgentProviderRole = "planner" | "executor" | "reviewer";

type AgentProviderDefinition = {
  provider: string;
  role: AgentProviderRole;
  command: string;
  profile: string;
  profilePath: string;
  profileInstructions: string;
};

type AgentDirectiveStatus = "done" | "continue" | "blocked" | "failed";

type AgentDirective = {
  status: AgentDirectiveStatus;
  summary: string;
  nextPrompt: string;
};

type AgentSessionResult = {
  success: boolean;
  blocked: boolean;
  continueRequested: boolean;
  code: number | null;
  output: string;
  turns: number;
};

type AgentSessionTurn = {
  turn: number;
  startedAt: string;
  completedAt: string;
  promptFile: string;
  prompt: string;
  output: string;
  code: number | null;
  success: boolean;
  directiveStatus: AgentDirectiveStatus;
  directiveSummary: string;
  nextPrompt: string;
};

type AgentSessionState = {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  status: "running" | "done" | "blocked" | "failed";
  startedAt: string;
  updatedAt: string;
  maxTurns: number;
  turns: AgentSessionTurn[];
  lastPrompt: string;
  lastPromptFile: string;
  lastOutput: string;
  lastCode: number | null;
  lastDirectiveStatus: AgentDirectiveStatus;
  lastDirectiveSummary: string;
  nextPrompt: string;
};

type AgentPipelineState = {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  cycle: number;
  activeIndex: number;
  updatedAt: string;
  history: string[];
};

type FileSystemClientOptions = {
  basePath: string;
  bucket: string;
  keyPrefix?: string;
};

type S3dbResource = {
  get: (id: string) => Promise<any>;
  replace: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
};

type S3dbDatabase = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  usePlugin: (plugin: unknown, name?: string | null) => Promise<unknown>;
  createResource: (config: {
    name: string;
    attributes: Record<string, string>;
    behavior?: string;
    timestamps?: boolean;
    paranoid?: boolean;
  }) => Promise<unknown>;
  getResource: (name: string) => Promise<S3dbResource>;
};

type S3dbModule = {
  S3db: new (options: Record<string, unknown>) => S3dbDatabase;
  FileSystemClient: new (options: FileSystemClientOptions) => unknown;
  ApiPlugin: new (options: Record<string, unknown>) => {
    stop?: () => Promise<void>;
  };
};

function readArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    return undefined;
  }

  return value;
}

function resolveInputPath(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }

  return resolve(value);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const CLI_ARGS = argv.slice(2);
const CLI_WORKSPACE_ROOT = readArgValue(CLI_ARGS, "--workspace");
const CLI_PERSISTENCE = readArgValue(CLI_ARGS, "--persistence");
const DEFAULT_LOCAL_S3DB_CHECKOUT = resolve(homedir(), "Work/tetis/libs/s3db.js");
const TARGET_ROOT = resolveInputPath(env.SYMPHIFO_WORKSPACE_ROOT ?? CLI_WORKSPACE_ROOT ?? getCwd());

function resolvePersistenceRoot(value: string): string {
  const resolved = value.startsWith("file://")
    ? fileURLToPath(value)
    : resolveInputPath(value);

  return basename(resolved) === ".symphifo"
    ? resolved
    : join(resolved, ".symphifo");
}

const TRACKER_KIND = env.SYMPHIFO_TRACKER_KIND ?? "filesystem";
const STATE_ROOT = resolvePersistenceRoot(
  env.SYMPHIFO_PERSISTENCE
    ?? CLI_PERSISTENCE
    ?? env.SYMPHIFO_BOOTSTRAP_ROOT
    ?? TARGET_ROOT
);
const SOURCE_ROOT = `${STATE_ROOT}/source`;
const WORKSPACE_ROOT = `${STATE_ROOT}/workspaces`;
const SOURCE_MARKER = `${SOURCE_ROOT}/.symphifo-local-source-ready`;
const WORKFLOW_TEMPLATE = existsSync(join(TARGET_ROOT, "WORKFLOW.md"))
  ? join(TARGET_ROOT, "WORKFLOW.md")
  : existsSync(join(PACKAGE_ROOT, "WORKFLOW.md"))
    ? join(PACKAGE_ROOT, "WORKFLOW.md")
    : "";
const WORKFLOW_RENDERED = `${STATE_ROOT}/WORKFLOW.local.md`;
const S3DB_LIBRARY_PATH = env.SYMPHIFO_STORAGE_LIBRARY_PATH ?? "";
const S3DB_DATABASE_PATH = `${STATE_ROOT}/s3db`;
const S3DB_BUCKET = env.SYMPHIFO_STORAGE_BUCKET ?? "symphifo";
const S3DB_KEY_PREFIX = env.SYMPHIFO_STORAGE_KEY_PREFIX ?? "state";
const S3DB_RUNTIME_RESOURCE = "symphifo_runtime_state";
const S3DB_ISSUE_RESOURCE = "symphifo_issues";
const S3DB_EVENT_RESOURCE = "symphifo_events";
const S3DB_AGENT_SESSION_RESOURCE = "symphifo_agent_sessions";
const S3DB_AGENT_PIPELINE_RESOURCE = "symphifo_agent_pipelines";
const S3DB_RUNTIME_RECORD_ID = "current";
const S3DB_RUNTIME_SCHEMA_VERSION = 1;
const DEFAULT_ISSUES_TEMPLATE = `${PACKAGE_ROOT}/src/fixtures/local-issues.json`;
const LOCAL_ISSUES_FILE = resolveInputPath(env.SYMPHIFO_ISSUES_FILE ?? join(STATE_ROOT, "issues.json"));
const FRONTEND_DIR = `${PACKAGE_ROOT}/src/dashboard`;
const FRONTEND_INDEX = `${FRONTEND_DIR}/index.html`;
const FRONTEND_APP_JS = `${FRONTEND_DIR}/app.js`;
const FRONTEND_STYLES_CSS = `${FRONTEND_DIR}/styles.css`;
const DEBUG_BOOT = env.SYMPHIFO_DEBUG_BOOT === "1";

const LOG_PATH = `${STATE_ROOT}/symphifo-local.log`;

const ALLOWED_STATES: IssueState[] = ["Todo", "In Progress", "In Review", "Blocked", "Done", "Cancelled"];
const TERMINAL_STATES = new Set<IssueState>(["Done", "Cancelled"]);
const EXECUTING_STATES = new Set<IssueState>(["In Progress", "In Review"]);
const PERSIST_EVENTS_MAX = 500;

let loadedS3dbModule: S3dbModule | null = null;
let stateDb: S3dbDatabase | null = null;
let runtimeStateResource: S3dbResource | null = null;
let issueStateResource: S3dbResource | null = null;
let eventStateResource: S3dbResource | null = null;
let agentSessionResource: S3dbResource | null = null;
let agentPipelineResource: S3dbResource | null = null;
let activeApiPlugin: { stop?: () => Promise<void> } | null = null;
let workflowDefinition: WorkflowDefinition | null = null;

function resolveAgentProfile(name: string): { profilePath: string; instructions: string } {
  const normalized = name.trim();
  if (!normalized) {
    return { profilePath: "", instructions: "" };
  }

  const candidates = [
    join(TARGET_ROOT, ".codex", "agents", `${normalized}.md`),
    join(TARGET_ROOT, ".codex", "agents", normalized, "AGENT.md"),
    join(TARGET_ROOT, "agents", `${normalized}.md`),
    join(TARGET_ROOT, "agents", normalized, "AGENT.md"),
    join(homedir(), ".codex", "agents", `${normalized}.md`),
    join(homedir(), ".codex", "agents", normalized, "AGENT.md"),
    join(homedir(), ".claude", "agents", `${normalized}.md`),
    join(homedir(), ".claude", "agents", normalized, "AGENT.md"),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    return {
      profilePath: candidate,
      instructions: readFileSync(candidate, "utf8").trim(),
    };
  }

  return { profilePath: "", instructions: "" };
}

function normalizeAgentProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "claude" || normalized === "codex") {
    return normalized;
  }

  if (!normalized) {
    return "codex";
  }

  return normalized;
}

function normalizeAgentRole(value: string): AgentProviderRole {
  const normalized = value.trim().toLowerCase();
  if (normalized === "planner" || normalized === "executor" || normalized === "reviewer") {
    return normalized;
  }

  return "executor";
}

function resolveAgentCommand(
  provider: string,
  explicitCommand: string,
  codexCommand: string,
  claudeCommand: string,
): string {
  if (explicitCommand.trim()) {
    return explicitCommand.trim();
  }

  if (provider === "claude" && claudeCommand.trim()) {
    return claudeCommand.trim();
  }

  if (provider === "codex" && codexCommand.trim()) {
    return codexCommand.trim();
  }

  return "";
}

function resolveWorkflowAgentProviders(
  config: JsonRecord,
  fallbackProvider: string,
  fallbackProfile: string,
  explicitCommand: string,
): AgentProviderDefinition[] {
  const agentConfig = getNestedRecord(config, "agent");
  const codexConfig = getNestedRecord(config, "codex");
  const claudeConfig = getNestedRecord(config, "claude");
  const providersRaw = (agentConfig.providers ?? []) as unknown;
  const providers: AgentProviderDefinition[] = [];

  if (Array.isArray(providersRaw)) {
    for (const entry of providersRaw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const record = entry as JsonRecord;
      const provider = normalizeAgentProvider(
        toStringValue(record.provider) || toStringValue(record.name) || fallbackProvider,
      );
      const role = normalizeAgentRole(toStringValue(record.role, "executor"));
      const profile = toStringValue(record.profile, role === "executor" ? fallbackProfile : "");
      const resolvedProfile = resolveAgentProfile(profile);
      const command = resolveAgentCommand(
        provider,
        toStringValue(record.command),
        getNestedString(codexConfig, "command"),
        getNestedString(claudeConfig, "command"),
      );

      providers.push({
        provider,
        role,
        command,
        profile,
        profilePath: resolvedProfile.profilePath,
        profileInstructions: resolvedProfile.instructions,
      });
    }
  }

  if (providers.length > 0) {
    return providers;
  }

  const resolvedProfile = resolveAgentProfile(fallbackProfile);
  return [
    {
      provider: fallbackProvider,
      role: "executor",
      command: resolveAgentCommand(
        fallbackProvider,
        explicitCommand,
        getNestedString(codexConfig, "command"),
        getNestedString(claudeConfig, "command"),
      ),
      profile: fallbackProfile,
      profilePath: resolvedProfile.profilePath,
      profileInstructions: resolvedProfile.instructions,
    },
  ];
}

function fail(message: string): never {
  console.error(message);
  exit(1);
}

async function loadS3dbModule(): Promise<S3dbModule> {
  if (loadedS3dbModule) {
    return loadedS3dbModule;
  }

  const configuredPath = S3DB_LIBRARY_PATH ? resolveInputPath(S3DB_LIBRARY_PATH) : "";
  const defaultCheckoutEntry = resolve(DEFAULT_LOCAL_S3DB_CHECKOUT, "dist", "index.js");
  const checkoutEntry = configuredPath
    ? (extname(configuredPath).toLowerCase() === ".js" ? configuredPath : resolve(configuredPath, "dist", "index.js"))
    : existsSync(defaultCheckoutEntry)
      ? defaultCheckoutEntry
      : "";

  const candidates = [
    {
      kind: "package" as const,
      label: "installed package",
      entry: "s3db.js",
      pluginEntry: "s3db.js/plugins/index",
    },
    ...(checkoutEntry
      ? [{
          kind: "checkout" as const,
          label: checkoutEntry,
          entry: pathToFileURL(checkoutEntry).href,
          pluginEntry: pathToFileURL(resolve(dirname(checkoutEntry), "plugins", "index.js")).href,
        }]
      : []),
  ];

  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const imported = await import(candidate.entry) as unknown as Record<string, unknown>;
      const pluginModule = await import(candidate.pluginEntry);

      let ApiPluginCtor: S3dbModule["ApiPlugin"] | undefined;
      if (typeof (pluginModule as Record<string, unknown>).ApiPlugin === "function") {
        ApiPluginCtor = (pluginModule as { ApiPlugin: S3dbModule["ApiPlugin"] }).ApiPlugin;
      } else if (typeof (pluginModule as Record<string, unknown>).loadApiPlugin === "function") {
        ApiPluginCtor = await (pluginModule as { loadApiPlugin: () => Promise<S3dbModule["ApiPlugin"]> }).loadApiPlugin();
      }

      if (!ApiPluginCtor) {
        throw new Error("ApiPlugin export not found.");
      }

      loadedS3dbModule = {
        S3db: imported.S3db as S3dbModule["S3db"],
        FileSystemClient: imported.FileSystemClient as S3dbModule["FileSystemClient"],
        ApiPlugin: ApiPluginCtor,
      };
      return loadedS3dbModule;
    } catch (error) {
      lastError = error;
      appendLog(`Failed to load s3db.js from ${candidate.label}: ${String(error)}`);
    }
  }

  fail(`Failed to load s3db.js: ${String(lastError)}`);
}

async function initStateStore() {
  debugBoot("initStateStore:start");
  const { S3db, FileSystemClient } = await loadS3dbModule();
  debugBoot("initStateStore:module-loaded");

  mkdirSync(S3DB_DATABASE_PATH, { recursive: true });

  stateDb = new S3db({
    client: new FileSystemClient({
      basePath: S3DB_DATABASE_PATH,
      bucket: S3DB_BUCKET,
      keyPrefix: S3DB_KEY_PREFIX,
    }),
  });

  await stateDb.connect();
  debugBoot("initStateStore:connected");

  await stateDb.createResource({
    name: S3DB_RUNTIME_RESOURCE,
    attributes: {
      id: "string|required",
      schemaVersion: "number|required",
      trackerKind: "string|required",
      runtimeTag: "string|optional",
      updatedAt: "datetime|required",
      state: "json|required",
    },
    behavior: "body-overflow",
    paranoid: false,
    timestamps: false,
  });

  await stateDb.createResource({
    name: S3DB_ISSUE_RESOURCE,
    attributes: {
      id: "string|required",
      identifier: "string|required",
      title: "string|required",
      description: "string|optional",
      priority: "number|required",
      state: "string|required",
      branchName: "string|optional",
      url: "string|optional",
      assigneeId: "string|optional",
      labels: "json|required",
      blockedBy: "json|required",
      assignedToWorker: "boolean|required",
      createdAt: "datetime|required",
      updatedAt: "datetime|required",
      history: "json|required",
      startedAt: "datetime|optional",
      completedAt: "datetime|optional",
      attempts: "number|required",
      maxAttempts: "number|required",
      nextRetryAt: "datetime|optional",
      workspacePath: "string|optional",
      workspacePreparedAt: "datetime|optional",
      lastError: "string|optional",
      durationMs: "number|optional",
      commandExitCode: "number|optional",
      commandOutputTail: "string|optional",
    },
    behavior: "body-overflow",
    paranoid: false,
    timestamps: false,
  });

  await stateDb.createResource({
    name: S3DB_EVENT_RESOURCE,
    attributes: {
      id: "string|required",
      issueId: "string|optional",
      kind: "string|required",
      message: "string|required",
      at: "datetime|required",
    },
    behavior: "body-overflow",
    paranoid: false,
    timestamps: false,
  });

  await stateDb.createResource({
    name: S3DB_AGENT_SESSION_RESOURCE,
    attributes: {
      id: "string|required",
      issueId: "string|required",
      issueIdentifier: "string|required",
      attempt: "number|required",
      cycle: "number|required",
      provider: "string|required",
      role: "string|required",
      updatedAt: "datetime|required",
      session: "json|required",
    },
    behavior: "body-overflow",
    paranoid: false,
    timestamps: false,
  });

  await stateDb.createResource({
    name: S3DB_AGENT_PIPELINE_RESOURCE,
    attributes: {
      id: "string|required",
      issueId: "string|required",
      issueIdentifier: "string|required",
      attempt: "number|required",
      updatedAt: "datetime|required",
      pipeline: "json|required",
    },
    behavior: "body-overflow",
    paranoid: false,
    timestamps: false,
  });

  runtimeStateResource = await stateDb.getResource(S3DB_RUNTIME_RESOURCE);
  issueStateResource = await stateDb.getResource(S3DB_ISSUE_RESOURCE);
  eventStateResource = await stateDb.getResource(S3DB_EVENT_RESOURCE);
  agentSessionResource = await stateDb.getResource(S3DB_AGENT_SESSION_RESOURCE);
  agentPipelineResource = await stateDb.getResource(S3DB_AGENT_PIPELINE_RESOURCE);
  debugBoot("initStateStore:resources-ready");
}

function isStateNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    return /not found|does not exist|no such key/i.test(error.message);
  }
  if (typeof error === "string") {
    return /not found|does not exist|no such key/i.test(error);
  }
  return false;
}

async function loadPersistedState(): Promise<RuntimeState | null> {
  if (!runtimeStateResource) {
    return null;
  }

  try {
    const record = await runtimeStateResource.get(S3DB_RUNTIME_RECORD_ID);
    if (record?.state && typeof record.state === "object") {
      return record.state as RuntimeState;
    }
  } catch (error) {
    if (!isStateNotFoundError(error)) {
      appendLog(`Could not load persisted state from s3db: ${String(error)}`);
    }
  }

  return null;
}

async function persistState(state: RuntimeState) {
  state.metrics = {
    ...computeMetrics(state.issues),
    activeWorkers: state.metrics.activeWorkers,
  };

  if (!runtimeStateResource) {
    return;
  }

  await runtimeStateResource.replace(S3DB_RUNTIME_RECORD_ID, {
    id: S3DB_RUNTIME_RECORD_ID,
    schemaVersion: S3DB_RUNTIME_SCHEMA_VERSION,
    trackerKind: "filesystem",
    runtimeTag: "local-only",
    updatedAt: now(),
    state,
  } satisfies RuntimeStateRecord);

  if (issueStateResource) {
    for (const issue of state.issues) {
      await issueStateResource.replace(issue.id, {
        ...issue,
        commandExitCode: typeof issue.commandExitCode === "number" ? issue.commandExitCode : undefined,
      } satisfies IssueRecord);
    }
  }

  if (eventStateResource) {
    for (const event of state.events) {
      await eventStateResource.replace(event.id, event satisfies EventRecord);
    }
  }
}

async function closeStateStore() {
  if (activeApiPlugin?.stop) {
    try {
      await activeApiPlugin.stop();
    } catch (error) {
      appendLog(`Failed to stop API plugin: ${String(error)}`);
    } finally {
      activeApiPlugin = null;
    }
  }

  if (!stateDb) {
    return;
  }

  try {
    await stateDb.disconnect();
  } catch (error) {
    appendLog(`Failed to close s3db runtime store: ${String(error)}`);
  } finally {
    stateDb = null;
    runtimeStateResource = null;
    issueStateResource = null;
    eventStateResource = null;
    agentSessionResource = null;
    agentPipelineResource = null;
  }
}

function log(message: string) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${message}`);
}

function now() {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function toNumberValue(value: unknown, fallback = 1): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function toBooleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeState(value: unknown): IssueState {
  const raw = typeof value === "string" ? value.trim() : "";
  if ((ALLOWED_STATES as readonly string[]).includes(raw)) {
    return raw as IssueState;
  }
  return "Todo";
}

function parseEnvNumber(name: string, fallback: number): number {
  return toNumberValue(env[name], fallback);
}

function parseIntArg(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const source = env[name];
  if (!source) {
    return fallback;
  }

  return parseIntArg(source, fallback);
}

function withRetryBackoff(attempt: number, baseDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** attempt, 5 * 60 * 1000);
}

function idToSafePath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

function appendFileTail(target: string, text: string, maxLength: number): string {
  const merged = `${target}\n${text}`;
  if (merged.length <= maxLength) {
    return merged;
  }

  return `…${merged.slice(-(maxLength - 1))}`;
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseFrontMatter(source: string): { config: JsonRecord; body: string } {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { config: {}, body: source.trim() };
  }

  const rawConfig = parseYaml(match[1]) as unknown;
  const config = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
    ? rawConfig as JsonRecord
    : {};

  return {
    config,
    body: match[2].trim(),
  };
}

function getNestedRecord(source: unknown, key: string): JsonRecord {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }

  const value = (source as JsonRecord)[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function getNestedString(source: unknown, key: string, fallback = ""): string {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return fallback;
  }

  return toStringValue((source as JsonRecord)[key], fallback);
}

function getNestedNumber(source: unknown, key: string, fallback: number): number {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return fallback;
  }

  return toNumberValue((source as JsonRecord)[key], fallback);
}

function appendLog(entry: string) {
  appendFileSync(LOG_PATH, `${now()} [symphifo-local-ts] ${entry}\n`, "utf8");
}

function debugBoot(message: string) {
  if (!DEBUG_BOOT) {
    return;
  }

  console.error(`[SYMPHIFO_DEBUG_BOOT] ${message}`);
}

function bootstrapSource() {
  if (existsSync(SOURCE_MARKER)) {
    return;
  }

  log("Creating local source snapshot for Symphifo (local-only runtime)...");

  const skipDirs = new Set([
    ".git",
    ".symphifo",
    "node_modules",
    ".venv",
    "data",
    "app/data",
    "app/dist",
    "app/.tanstack",
    "apk-pull",
    "mobile-assets",
    "pcap-archive",
    "lua-extract",
    "locale-extract",
  ]);

  const shouldSkip = (relativePath: string): boolean => {
    const parts = relativePath.split("/");
    if (parts.some((segment) => skipDirs.has(segment))) {
      return true;
    }

    const base = relativePath.split("/").at(-1) ?? "";
    if (base.startsWith("map_scan_") && extname(base) === ".json") {
      return true;
    }

    if (extname(base) === ".xlsx") {
      return true;
    }

    return false;
  };

  const copyRecursive = (source: string, target: string, rel = "") => {
    mkdirSync(target, { recursive: true });
    const items = readdirSync(source, { withFileTypes: true });

    for (const item of items) {
      const nextRel = rel ? `${rel}/${item.name}` : item.name;
      if (shouldSkip(nextRel)) {
        continue;
      }

      const sourcePath = `${source}/${item.name}`;
      const targetPath = `${target}/${item.name}`;
      const itemStat = statSync(sourcePath);

      if (item.isDirectory()) {
        copyRecursive(sourcePath, targetPath, nextRel);
        continue;
      }

      if (item.isSymbolicLink() || itemStat.isSymbolicLink()) {
        continue;
      }

      if (itemStat.isFile() || itemStat.isFIFO()) {
        try {
          const file = readFileSync(sourcePath);
          writeFileSync(targetPath, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            log(`Skipped missing source file: ${sourcePath}`);
          } else {
            throw error;
          }
        }
      }
    }
  };

  mkdirSync(SOURCE_ROOT, { recursive: true });
  copyRecursive(TARGET_ROOT, SOURCE_ROOT);
  writeFileSync(SOURCE_MARKER, `${now()}\n`, "utf8");
}

function loadWorkflowDefinition(): WorkflowDefinition {
  const template = WORKFLOW_TEMPLATE
    ? readFileSync(WORKFLOW_TEMPLATE, "utf8")
    : [
      "---",
      "tracker:",
      "  kind: filesystem",
      "workspace:",
      `  root: "${WORKSPACE_ROOT}"`,
      "agent:",
      "  max_concurrent_agents: 2",
      "  max_attempts: 3",
      "codex:",
      "  command: \"\"",
      "---",
      "",
      "You are working on {{ issue.identifier }}.",
      "",
      "Title: {{ issue.title }}",
      "Description:",
      "{{ issue.description }}",
    ].join("\n");

  const { config, body } = parseFrontMatter(template);
  const normalizedConfig: JsonRecord = {
    ...config,
    tracker: {
      ...getNestedRecord(config, "tracker"),
      kind: "filesystem",
      project_slug: "",
    },
  };

  const rendered = [
    "---",
    stringifyYaml(normalizedConfig).trim(),
    "---",
    "",
    body,
    "",
  ].join("\n");

  const agentConfig = getNestedRecord(normalizedConfig, "agent");
  const agentProvider = normalizeAgentProvider(getNestedString(agentConfig, "provider", "codex"));
  const agentProfile = getNestedString(agentConfig, "profile");
  const resolvedProfile = resolveAgentProfile(agentProfile);
  const agentProviders = resolveWorkflowAgentProviders(normalizedConfig, agentProvider, agentProfile, "");

  writeFileSync(WORKFLOW_RENDERED, rendered, "utf8");

  return {
    workflowPath: WORKFLOW_TEMPLATE || WORKFLOW_RENDERED,
    rendered,
    config: normalizedConfig,
    promptTemplate: body,
    agentProvider,
    agentProfile,
    agentProfilePath: resolvedProfile.profilePath,
    agentProfileInstructions: resolvedProfile.instructions,
    agentProviders,
    afterCreateHook: getNestedString(getNestedRecord(normalizedConfig, "hooks"), "after_create"),
    beforeRunHook: getNestedString(getNestedRecord(normalizedConfig, "hooks"), "before_run"),
    afterRunHook: getNestedString(getNestedRecord(normalizedConfig, "hooks"), "after_run"),
  };
}

function parsePort(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: ${argv[1]} [options]\n` +
        "Options:\n" +
        "  --port <n>             Start local dashboard (default: no UI and single batch run)\n" +
        "  --workspace <path>     Target workspace root (default: current directory)\n" +
        "  --persistence <path>   Persistence root (default: current directory)\n" +
        "  --concurrency <n>      Maximum number of parallel issue runners\n" +
        "  --attempts <n>         Maximum attempts per issue\n" +
        "  --poll <ms>            Polling interval for the scheduler\n" +
        "  --once                  Run one local batch and exit\n" +
        "  --help                  Show this message");
      exit(0);
    }

    if (arg === "--port") {
      const value = args[i + 1];
      if (!value || !/^\d+$/.test(value)) {
        fail(`Invalid value for --port: ${value ?? "<empty>"}`);
      }
      return parseIntArg(value, 4040);
    }
  }

  return undefined;
}

function normalizeIssue(raw: JsonRecord): IssueEntry | null {
  const id = toStringValue(raw.id, "") || toStringValue(raw.identifier, "");
  if (!id) {
    return null;
  }

  const createdAt = toStringValue(raw.created_at, now());
  const updatedAt = toStringValue(raw.updated_at, createdAt);

  return {
    id,
    identifier: toStringValue(raw.identifier, id),
    title: toStringValue(raw.title, `Issue ${id}`),
    description: toStringValue(raw.description, ""),
    priority: toNumberValue(raw.priority, 1),
    state: normalizeState(raw.state),
    branchName: toStringValue(raw.branch_name) || toStringValue(raw.branchName),
    url: toStringValue(raw.url),
    assigneeId: toStringValue(raw.assignee_id),
    labels: toStringArray(raw.labels),
    blockedBy: toStringArray(raw.blocked_by),
    assignedToWorker: toBooleanValue(raw.assigned_to_worker, true),
    createdAt,
    updatedAt,
    history: [],
    attempts: toNumberValue(raw.attempts, 0),
    maxAttempts: toNumberValue(raw.max_attempts, 3),
    nextRetryAt: toStringValue(raw.next_retry_at),
  };
}

function loadSeedIssues(path: string): IssueEntry[] {
  const sourcePath = env.SYMPHIFO_ISSUES_JSON ?? path;

  if (sourcePath !== path && sourcePath) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${sourcePath}\n`, "utf8");
  }

  if (!existsSync(path)) {
    return [];
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Invalid local issues JSON: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    fail("Local issues payload must be an array.");
  }

  const issues = parsed
    .filter((candidate): candidate is JsonRecord => typeof candidate === "object" && candidate !== null)
    .map(normalizeIssue)
    .filter((issue): issue is IssueEntry => issue !== null);

  return issues;
}

function nextLocalIssueId(issues: IssueEntry[]): string {
  const maxId = issues.reduce((current, issue) => {
    const match = issue.identifier.match(/^LOCAL-(\d+)$/);
    if (!match) {
      return current;
    }

    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? Math.max(current, parsed) : current;
  }, 0);

  return `LOCAL-${maxId + 1}`;
}

function createIssueFromPayload(payload: JsonRecord, issues: IssueEntry[]): IssueEntry {
  const identifier = toStringValue(payload.identifier, nextLocalIssueId(issues));
  const id = toStringValue(payload.id, identifier);
  const createdAt = now();
  const blockedBy = toStringArray(payload.blockedBy);
  const legacyBlockedBy = toStringArray(payload.blocked_by);

  return {
    id,
    identifier,
    title: toStringValue(payload.title, `Issue ${identifier}`),
    description: toStringValue(payload.description, ""),
    priority: clamp(toNumberValue(payload.priority, 1), 1, 10),
    state: "Todo",
    branchName: toStringValue(payload.branchName) || toStringValue(payload.branch_name),
    url: toStringValue(payload.url),
    assigneeId: toStringValue(payload.assigneeId) || toStringValue(payload.assignee_id),
    labels: toStringArray(payload.labels),
    blockedBy: blockedBy.length > 0 ? blockedBy : legacyBlockedBy,
    assignedToWorker: true,
    createdAt,
    updatedAt: createdAt,
    history: [`[${createdAt}] Issue created via API.`],
    attempts: 0,
    maxAttempts: clamp(toNumberValue(payload.maxAttempts ?? payload.max_attempts, 3), 1, 10),
  };
}

function deriveConfig(args: string[]): RuntimeConfig {
  const parsedConcurrency = parsePositiveIntEnv("SYMPHIFO_WORKER_CONCURRENCY", 2);
  let pollIntervalMs = parseEnvNumber("SYMPHIFO_POLL_INTERVAL_MS", 1200);
  let workerConcurrency = parsedConcurrency;
  let maxAttemptsDefault = parseEnvNumber("SYMPHIFO_MAX_ATTEMPTS", 3);
  let commandTimeoutMs = parseEnvNumber("SYMPHIFO_AGENT_TIMEOUT_MS", 120000);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--poll") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) {
        fail(`Invalid value for --poll: ${value}`);
      }
      pollIntervalMs = parseIntArg(value, pollIntervalMs);
    }

    if (arg === "--concurrency") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) {
        fail(`Invalid value for --concurrency: ${value}`);
      }
      workerConcurrency = parseIntArg(value, workerConcurrency);
    }

    if (arg === "--attempts") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) {
        fail(`Invalid value for --attempts: ${value}`);
      }
      maxAttemptsDefault = parseIntArg(value, maxAttemptsDefault);
    }
  }

  return {
    pollIntervalMs: clamp(pollIntervalMs, 200, 10_000),
    workerConcurrency: clamp(workerConcurrency, 1, 16),
    commandTimeoutMs: clamp(commandTimeoutMs, 1_000, 600_000),
    maxAttemptsDefault: clamp(maxAttemptsDefault, 1, 10),
    maxTurns: clamp(parseEnvNumber("SYMPHIFO_AGENT_MAX_TURNS", 4), 1, 16),
    retryDelayMs: parseEnvNumber("SYMPHIFO_RETRY_DELAY_MS", 3_000),
    staleInProgressTimeoutMs: parseEnvNumber("SYMPHIFO_STALE_IN_PROGRESS_MS", 20_000),
    logLinesTail: parseEnvNumber("SYMPHIFO_LOG_TAIL_CHARS", 12_000),
    agentProvider: normalizeAgentProvider(env.SYMPHIFO_AGENT_PROVIDER ?? "codex"),
    agentCommand: toStringValue(env.SYMPHIFO_AGENT_COMMAND, ""),
    runMode: "filesystem",
  };
}

function applyWorkflowConfig(config: RuntimeConfig, definition: WorkflowDefinition, port: number | undefined): RuntimeConfig {
  const pollConfig = getNestedRecord(definition.config, "poll");
  const agentConfig = getNestedRecord(definition.config, "agent");
  const codexConfig = getNestedRecord(definition.config, "codex");
  const claudeConfig = getNestedRecord(definition.config, "claude");
  const serverConfig = getNestedRecord(definition.config, "server");
  const agentProvider = normalizeAgentProvider(getNestedString(agentConfig, "provider", definition.agentProvider || config.agentProvider));
  const codexCommand = getNestedString(codexConfig, "command");
  const claudeCommand = getNestedString(claudeConfig, "command");

  return {
    ...config,
    pollIntervalMs: clamp(getNestedNumber(pollConfig, "interval_ms", config.pollIntervalMs), 200, 10_000),
    workerConcurrency: clamp(
      getNestedNumber(agentConfig, "max_concurrent_agents", config.workerConcurrency),
      1,
      16,
    ),
    maxAttemptsDefault: clamp(getNestedNumber(agentConfig, "max_attempts", config.maxAttemptsDefault), 1, 10),
    maxTurns: clamp(getNestedNumber(agentConfig, "max_turns", config.maxTurns), 1, 16),
    commandTimeoutMs: clamp(
      getNestedNumber(codexConfig, "timeout_ms", config.commandTimeoutMs),
      1_000,
      600_000,
    ),
    agentProvider,
    agentCommand: resolveAgentCommand(agentProvider, config.agentCommand, codexCommand, claudeCommand),
    dashboardPort: String(port ?? (getNestedNumber(serverConfig, "port", Number.parseInt(config.dashboardPort ?? "0", 10) || 0) || 0)),
    runMode: "filesystem",
  };
}

function dedupHistoryEntries(issues: IssueEntry[]) {
  for (const issue of issues) {
    const seen = new Set<string>();
    issue.history = issue.history.filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}

function mergeStateWithSeed(seedIssues: IssueEntry[], previous: RuntimeState | null, config: RuntimeConfig, definition: WorkflowDefinition): RuntimeState {
  const previousMap = new Map((previous?.issues ?? []).map((issue) => [issue.id, issue]));

  const mergedIssues = seedIssues.map((seed) => {
    const saved = previousMap.get(seed.id);
    if (!saved) {
      return seed;
    }

    return {
      ...seed,
      state: normalizeState(saved.state),
      history: saved.history,
      attempts: clamp(saved.attempts, 0, config.maxAttemptsDefault),
      maxAttempts: clamp(saved.maxAttempts, 1, config.maxAttemptsDefault),
      nextRetryAt: toStringValue(saved.nextRetryAt),
      startedAt: saved.startedAt,
      completedAt: saved.completedAt,
      updatedAt: saved.updatedAt,
      workspacePath: saved.workspacePath,
      workspacePreparedAt: saved.workspacePreparedAt,
      lastError: saved.lastError,
      durationMs: typeof saved.durationMs === "number" ? saved.durationMs : undefined,
      commandExitCode: typeof saved.commandExitCode === "number" ? saved.commandExitCode : saved.commandExitCode,
      commandOutputTail: toStringValue(saved.commandOutputTail),
    };
  });

  dedupHistoryEntries(mergedIssues);

  const metrics = computeMetrics(mergedIssues);

  const runtimeState: RuntimeState = {
    startedAt: previous?.startedAt ?? now(),
    updatedAt: now(),
    trackerKind: "filesystem",
    sourceRepoUrl: TARGET_ROOT,
    sourceRef: "workspace",
    workflowPath: WORKFLOW_RENDERED,
    config: {
      ...config,
      dashboardPort: previous?.config.dashboardPort,
    },
    issues: mergedIssues,
    events: previous?.events ?? [],
    metrics,
    notes: previous?.notes ?? [
      "Local TypeScript runtime bootstrapped.",
      `Workflow loaded from ${definition.workflowPath}.`,
      "Codex-only execution path enabled.",
      "No external tracker dependency (filesystem-backed local mode).",
    ],
  };

  return runtimeState;
}

function computeMetrics(issues: IssueEntry[]): RuntimeMetrics {
  let queued = 0;
  let inProgress = 0;
  let blocked = 0;
  let done = 0;
  let cancelled = 0;

  for (const issue of issues) {
    switch (issue.state) {
      case "Todo":
      case "Blocked":
        queued += 1;
        break;
      case "In Progress":
      case "In Review":
        inProgress += 1;
        break;
      case "Done":
        done += 1;
        break;
      case "Cancelled":
        cancelled += 1;
        break;
    }

    if (issue.state === "Blocked") {
      blocked += 1;
    }
  }

  return {
    total: issues.length,
    queued,
    inProgress,
    blocked,
    done,
    cancelled,
    activeWorkers: 0,
  };
}

function addEvent(state: RuntimeState, issueId: string | undefined, kind: RuntimeEventType, message: string) {
  const event: RuntimeEvent = {
    id: `${Date.now()}-${state.events.length + 1}`,
    issueId,
    kind,
    message,
    at: now(),
  };

  state.events = [event, ...state.events].slice(0, PERSIST_EVENTS_MAX);
  appendLog(`${issueId ? `[${issueId}] ` : ""}${message}`);
}

function transition(issue: IssueEntry, target: IssueState, note: string) {
  const previous = issue.state;
  issue.state = target;
  issue.updatedAt = now();
  issue.history.push(`[${issue.updatedAt}] ${note}`);

  if (previous === "Blocked" && target === "Todo") {
    issue.lastError = undefined;
    issue.nextRetryAt = undefined;
  }

  if (TERMINAL_STATES.has(target)) {
    issue.completedAt = now();
    issue.nextRetryAt = undefined;
  }

  if (target === "Todo") {
    issue.attempts = Math.max(0, issue.attempts - 1);
  }

  if (target === "Done") {
    issue.lastError = undefined;
  }
}

function issueDependenciesResolved(issue: IssueEntry, allIssues: IssueEntry[]): boolean {
  if (issue.blockedBy.length === 0) {
    return true;
  }

  const map = new Map(allIssues.map((entry) => [entry.id, entry]));
  return issue.blockedBy.every((dependencyId) => {
    const dep = map.get(dependencyId);
    return dep?.state === "Done";
  });
}

function getNextRetryAt(issue: IssueEntry, baseMs: number): string {
  const nextAttempt = issue.attempts + 1;
  const nextDelay = withRetryBackoff(nextAttempt, baseMs);
  return new Date(Date.now() + nextDelay).toISOString();
}

function canRunIssue(issue: IssueEntry, running: Set<string>, state: RuntimeState): boolean {
  if (!issue.assignedToWorker) {
    return false;
  }

  if (running.has(issue.id)) {
    return false;
  }

  if (TERMINAL_STATES.has(issue.state)) {
    return false;
  }

  if (issue.state === "Blocked") {
    if (!issue.nextRetryAt) {
      return false;
    }

    if (issue.attempts >= issue.maxAttempts) {
      return false;
    }

    if (Date.parse(issue.nextRetryAt) > Date.now()) {
      return false;
    }
  }

  if (!issueDependenciesResolved(issue, state.issues)) {
    return false;
  }

  if (issue.state === "Todo" || issue.state === "Blocked") {
    return true;
  }

  if (issue.state === "In Progress" && issueHasResumableSession(issue)) {
    return true;
  }

  return false;
}

function buildPrompt(issue: IssueEntry): string {
  const template = workflowDefinition?.promptTemplate.trim() || [
    "You are working on {{ issue.identifier }}.",
    "",
    "Title: {{ issue.title }}",
    "Description:",
    "{{ issue.description }}",
  ].join("\n");

  return template.replace(/{{\s*issue\.([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
    const value = issue[key as keyof IssueEntry];
    if (Array.isArray(value)) {
      return value.join(", ");
    }
    return value == null ? "" : String(value);
  });
}

function normalizeAgentDirectiveStatus(value: unknown, fallback: AgentDirectiveStatus): AgentDirectiveStatus {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "done" || normalized === "continue" || normalized === "blocked" || normalized === "failed") {
    return normalized;
  }
  return fallback;
}

function extractOutputMarker(output: string, name: string): string {
  const match = output.match(new RegExp(`^${name}=(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function readAgentDirective(workspacePath: string, output: string, success: boolean): AgentDirective {
  const fallbackStatus: AgentDirectiveStatus = success ? "done" : "failed";
  const resultFile = join(workspacePath, "symphifo-result.json");
  let resultPayload: JsonRecord = {};

  if (existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(readFileSync(resultFile, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        resultPayload = parsed as JsonRecord;
      }
    } catch (error) {
      appendLog(`Invalid symphifo-result.json in ${workspacePath}: ${String(error)}`);
    }
  }

  const status = normalizeAgentDirectiveStatus(
    resultPayload.status ?? extractOutputMarker(output, "SYMPHIFO_STATUS"),
    fallbackStatus,
  );
  const summary =
    toStringValue(resultPayload.summary)
    || toStringValue(resultPayload.message)
    || extractOutputMarker(output, "SYMPHIFO_SUMMARY");
  const nextPrompt =
    toStringValue(resultPayload.nextPrompt)
    || toStringValue(resultPayload.next_prompt)
    || "";

  return {
    status,
    summary,
    nextPrompt,
  };
}

function buildAgentSessionState(
  issue: IssueEntry,
  attempt: number,
  maxTurns: number,
): AgentSessionState {
  const createdAt = now();
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    attempt,
    status: "running",
    startedAt: createdAt,
    updatedAt: createdAt,
    maxTurns,
    turns: [],
    lastPrompt: "",
    lastPromptFile: "",
    lastOutput: "",
    lastCode: null,
    lastDirectiveStatus: "continue",
    lastDirectiveSummary: "",
    nextPrompt: "",
  };
}

async function loadAgentSessionState(
  sessionKey: string,
  issue: IssueEntry,
  attempt: number,
  maxTurns: number,
): Promise<{ session: AgentSessionState; key: string }> {
  if (agentSessionResource) {
    try {
      const record = await agentSessionResource.get(sessionKey) as AgentSessionRecord;
      if (
        record?.session
        && record.issueId === issue.id
        && record.attempt === attempt
        && Array.isArray(record.session.turns)
      ) {
        return {
          session: {
            ...buildAgentSessionState(issue, attempt, maxTurns),
            ...record.session,
            maxTurns,
            turns: record.session.turns as AgentSessionTurn[],
            updatedAt: now(),
          },
          key: sessionKey,
        };
      }
    } catch (error) {
      if (!isStateNotFoundError(error)) {
        appendLog(`Failed to load session state for ${issue.id}: ${String(error)}`);
      }
    }
  }

  return {
    session: buildAgentSessionState(issue, attempt, maxTurns),
    key: sessionKey,
  };
}

async function persistAgentSessionState(
  key: string,
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  cycle: number,
  session: AgentSessionState,
) {
  session.updatedAt = now();
  if (!agentSessionResource) {
    return;
  }

  await agentSessionResource.replace(key, {
    id: key,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    attempt: session.attempt,
    cycle,
    provider: provider.provider,
    role: provider.role,
    updatedAt: session.updatedAt,
    session,
  } satisfies AgentSessionRecord);
}

function issueHasResumableSession(issue: IssueEntry): boolean {
  return Boolean(issue.workspacePath) && issue.state === "In Progress";
}

function buildProviderSessionKey(issue: IssueEntry, attempt: number, provider: AgentProviderDefinition, cycle: number): string {
  return `${idToSafePath(issue.id)}-a${attempt}-${provider.role}-${provider.provider}-c${cycle}`;
}

function buildPipelineKey(issue: IssueEntry, attempt: number): string {
  return `${idToSafePath(issue.id)}-a${attempt}`;
}

function getLatestPipelineAttempt(issue: IssueEntry): number {
  if (issue.state === "Blocked" || issue.state === "Cancelled") {
    return Math.max(1, issue.attempts);
  }

  return Math.max(1, issue.attempts + 1);
}

function getEffectiveAgentProviders(state: RuntimeState): AgentProviderDefinition[] {
  if (workflowDefinition?.agentProviders?.length) {
    return workflowDefinition.agentProviders;
  }

  return [
    {
      provider: state.config.agentProvider,
      role: "executor",
      command: state.config.agentCommand,
      profile: workflowDefinition?.agentProfile ?? "",
      profilePath: workflowDefinition?.agentProfilePath ?? "",
      profileInstructions: workflowDefinition?.agentProfileInstructions ?? "",
    },
  ];
}

async function loadAgentPipelineState(
  issue: IssueEntry,
  attempt: number,
  providers: AgentProviderDefinition[],
): Promise<{ pipeline: AgentPipelineState; key: string }> {
  const pipelineKey = buildPipelineKey(issue, attempt);

  if (agentPipelineResource) {
    try {
      const record = await agentPipelineResource.get(pipelineKey) as AgentPipelineRecord;
      if (record?.pipeline && record.issueId === issue.id && record.attempt === attempt) {
        return {
          pipeline: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            attempt,
            cycle: Math.max(1, toNumberValue(record.pipeline.cycle, 1)),
            activeIndex: clamp(toNumberValue(record.pipeline.activeIndex, 0), 0, Math.max(0, providers.length - 1)),
            updatedAt: now(),
            history: Array.isArray(record.pipeline.history)
              ? record.pipeline.history.filter((entry): entry is string => typeof entry === "string")
              : [],
          },
          key: pipelineKey,
        };
      }
    } catch (error) {
      if (!isStateNotFoundError(error)) {
        appendLog(`Failed to load pipeline state for ${issue.id}: ${String(error)}`);
      }
    }
  }

  return {
    pipeline: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt,
      cycle: 1,
      activeIndex: 0,
      updatedAt: now(),
      history: [],
    },
    key: pipelineKey,
  };
}

async function persistAgentPipelineState(key: string, pipeline: AgentPipelineState) {
  pipeline.updatedAt = now();
  if (!agentPipelineResource) {
    return;
  }

  await agentPipelineResource.replace(key, {
    id: key,
    issueId: pipeline.issueId,
    issueIdentifier: pipeline.issueIdentifier,
    attempt: pipeline.attempt,
    updatedAt: pipeline.updatedAt,
    pipeline,
  } satisfies AgentPipelineRecord);
}

async function loadAgentPipelineSnapshotForIssue(
  issue: IssueEntry,
  providers: AgentProviderDefinition[],
): Promise<AgentPipelineState | null> {
  const attempt = getLatestPipelineAttempt(issue);
  const loaded = await loadAgentPipelineState(issue, attempt, providers);
  return loaded.pipeline.history.length > 0 ? loaded.pipeline : null;
}

async function loadAgentSessionSnapshotsForIssue(
  issue: IssueEntry,
  providers: AgentProviderDefinition[],
  pipeline: AgentPipelineState | null,
): Promise<Array<{ key: string; session: AgentSessionState; provider: string; role: AgentProviderRole; cycle: number }>> {
  if (!pipeline) {
    return [];
  }

  const sessions: Array<{ key: string; session: AgentSessionState; provider: string; role: AgentProviderRole; cycle: number }> = [];
  const attempt = pipeline.attempt;

  for (let cycle = 1; cycle <= pipeline.cycle; cycle += 1) {
    for (const provider of providers) {
      const key = buildProviderSessionKey(issue, attempt, provider, cycle);
      const loaded = await loadAgentSessionState(key, issue, attempt, stateConfigMaxTurnsFallback());
      if (loaded.session.turns.length === 0) {
        continue;
      }

      sessions.push({
        key,
        session: loaded.session,
        provider: provider.provider,
        role: provider.role,
        cycle,
      });
    }
  }

  return sessions;
}

function stateConfigMaxTurnsFallback(): number {
  return workflowDefinition
    ? clamp(getNestedNumber(getNestedRecord(workflowDefinition.config, "agent"), "max_turns", 4), 1, 16)
    : 4;
}

function buildTurnPrompt(
  issue: IssueEntry,
  basePrompt: string,
  previousOutput: string,
  turnIndex: number,
  maxTurns: number,
  nextPrompt: string,
): string {
  if (turnIndex === 1) {
    return basePrompt;
  }

  const outputTail = previousOutput.trim() || "No previous output captured.";
  const continuation = nextPrompt.trim() || "Continue the work, inspect the workspace, and move the issue toward completion.";

  return [
    `Continue working on ${issue.identifier}.`,
    `Turn ${turnIndex} of ${maxTurns}.`,
    "",
    "Base objective:",
    basePrompt,
    "",
    "Continuation guidance:",
    continuation,
    "",
    "Previous command output tail:",
    "```text",
    outputTail,
    "```",
    "",
    "Before exiting successfully, emit one of the following control markers:",
    "- `SYMPHIFO_STATUS=continue` if more turns are required.",
    "- `SYMPHIFO_STATUS=done` if the issue is complete.",
    "- `SYMPHIFO_STATUS=blocked` if manual intervention is required.",
    "You may also write `symphifo-result.json` with `{ \"status\": \"...\", \"summary\": \"...\", \"nextPrompt\": \"...\" }`.",
  ].join("\n");
}

function buildProviderBasePrompt(
  provider: AgentProviderDefinition,
  issue: IssueEntry,
  basePrompt: string,
  workspacePath: string,
): string {
  const roleInstructions = provider.role === "planner"
    ? [
      "Role: planner.",
      "Analyze the issue and prepare an execution plan for the implementation agents.",
      "Do not claim the issue is complete unless the plan itself is the deliverable.",
    ]
    : provider.role === "reviewer"
      ? [
        "Role: reviewer.",
        "Inspect the workspace and review the current implementation critically.",
        "If rework is required, emit `SYMPHIFO_STATUS=continue` and provide actionable `nextPrompt` feedback.",
        "Emit `SYMPHIFO_STATUS=done` only when the work is acceptable.",
      ]
      : [
        "Role: executor.",
        "Implement the required changes in the workspace.",
        "Use any planner guidance or prior reviewer feedback already persisted in the workspace.",
      ];

  return [
    ...roleInstructions,
    "",
    `Workspace: ${workspacePath}`,
    "",
    basePrompt,
  ].join("\n");
}

async function runCommandWithTimeout(
  command: string,
  workspacePath: string,
  issue: IssueEntry,
  config: RuntimeConfig,
  promptText: string,
  promptFile: string,
  extraEnv: Record<string, string> = {},
): Promise<{ success: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const resultFile = extraEnv.SYMPHIFO_RESULT_FILE;
    if (resultFile && extraEnv.SYMPHIFO_PRESERVE_RESULT_FILE !== "1") {
      rmSync(resultFile, { force: true });
    }

    const child = spawn(command, {
      shell: true,
      cwd: workspacePath,
      env: {
        ...env,
        SYMPHIFO_ISSUE_ID: issue.id,
        SYMPHIFO_ISSUE_IDENTIFIER: issue.identifier,
        SYMPHIFO_ISSUE_TITLE: issue.title,
        SYMPHIFO_ISSUE_PRIORITY: String(issue.priority),
        SYMPHIFO_WORKSPACE_PATH: workspacePath,
        SYMPHIFO_ISSUE_JSON: JSON.stringify(issue),
        SYMPHIFO_PROMPT: promptText,
        SYMPHIFO_PROMPT_FILE: promptFile,
        ...extraEnv,
      },
    });

    let output = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk) => {
      output = appendFileTail(output, String(chunk), config.logLinesTail);
    });

    child.stderr?.on("data", (chunk) => {
      output = appendFileTail(output, String(chunk), config.logLinesTail);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, config.commandTimeoutMs);

    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        success: false,
        code: null,
        output: `Command execution failed for issue ${issue.id}.`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          success: false,
          code: null,
          output: appendFileTail(output, `\nExecution timeout after ${config.commandTimeoutMs}ms.`, config.logLinesTail),
        });
        return;
      }

      const duration = Math.max(0, Date.now() - started);
      if (code === 0) {
        resolve({
          success: true,
          code,
          output: appendFileTail(output, `\nExecution succeeded in ${duration}ms.`, config.logLinesTail),
        });
        return;
      }

      resolve({
        success: false,
        code,
        output: appendFileTail(output, `\nCommand exit code ${code ?? "unknown"} after ${duration}ms.`, config.logLinesTail),
      });
    });
  });
}

async function runHook(
  command: string,
  workspacePath: string,
  issue: IssueEntry,
  hookName: string,
  extraEnv: Record<string, string> = {},
) {
  if (!command.trim()) {
    return;
  }

  const result = await runCommandWithTimeout(
    command,
    workspacePath,
    issue,
    {
      pollIntervalMs: 0,
      workerConcurrency: 1,
      commandTimeoutMs: 300_000,
      maxAttemptsDefault: 1,
      retryDelayMs: 0,
      staleInProgressTimeoutMs: 0,
      logLinesTail: 12_000,
      agentProvider: normalizeAgentProvider(env.SYMPHIFO_AGENT_PROVIDER ?? "codex"),
      agentCommand: command,
      maxTurns: 1,
      runMode: "filesystem",
    },
    "",
    "",
    {
      SYMPHIFO_HOOK_NAME: hookName,
      ...extraEnv,
    },
  );

  if (!result.success) {
    throw new Error(`${hookName} hook failed: ${result.output}`);
  }
}

async function prepareWorkspace(issue: IssueEntry): Promise<{ workspacePath: string; promptText: string; promptFile: string }> {
  const safeId = idToSafePath(issue.id);
  const workspaceRoot = join(WORKSPACE_ROOT, safeId);
  const createdNow = !existsSync(workspaceRoot);

  if (createdNow) {
    mkdirSync(workspaceRoot, { recursive: true });
    if (workflowDefinition?.afterCreateHook) {
      await runHook(workflowDefinition.afterCreateHook, workspaceRoot, issue, "after_create");
    } else {
      cpSync(SOURCE_ROOT, workspaceRoot, {
        recursive: true,
        force: true,
        filter: (sourcePath) => {
          return !sourcePath.startsWith(WORKSPACE_ROOT);
        },
      });
    }
  }

  const metaPath = join(workspaceRoot, "symphifo-issue.json");
  const promptText = buildPrompt(issue);
  const promptFile = join(workspaceRoot, "symphifo-prompt.md");
  writeFileSync(metaPath, JSON.stringify({
    ...issue,
    runtimeSource: SOURCE_ROOT,
    bootstrapAt: now(),
  }, null, 2), "utf8");
  writeFileSync(promptFile, `${promptText}\n`, "utf8");

  issue.workspacePath = workspaceRoot;
  issue.workspacePreparedAt = now();

  return { workspacePath: workspaceRoot, promptText, promptFile };
}

async function runAgentSession(
  state: RuntimeState,
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  cycle: number,
  workspacePath: string,
  basePromptText: string,
  basePromptFile: string,
): Promise<AgentSessionResult> {
  const maxTurns = clamp(state.config.maxTurns, 1, 16);
  const attempt = issue.attempts + 1;
  const sessionLookupKey = buildProviderSessionKey(issue, attempt, provider, cycle);
  const loadedSession = await loadAgentSessionState(sessionLookupKey, issue, attempt, maxTurns);
  const sessionKey = loadedSession.key;
  const session = loadedSession.session;
  let previousOutput = session.lastOutput;
  let nextPrompt = session.nextPrompt;
  let lastCode: number | null = session.lastCode;
  let lastOutput = session.lastOutput;
  const resultFile = join(workspacePath, `symphifo-result-${provider.role}-${provider.provider}.json`);

  if (session.status === "done" && session.turns.length > 0) {
    return {
      success: true,
      blocked: false,
      continueRequested: false,
      code: session.lastCode,
      output: session.lastOutput,
      turns: session.turns.length,
    };
  }

  const turnIndex = session.turns.length + 1;
  if (turnIndex > maxTurns) {
    session.status = "blocked";
    session.lastOutput = appendFileTail(
      lastOutput,
      `\nAgent requested additional turns beyond configured limit (${maxTurns}).`,
      state.config.logLinesTail,
    );
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return {
      success: false,
      blocked: true,
      continueRequested: false,
      code: lastCode,
      output: session.lastOutput,
      turns: session.turns.length,
    };
  }

  const turnPrompt = buildTurnPrompt(issue, basePromptText, previousOutput, turnIndex, maxTurns, nextPrompt);
  const turnPromptFile = turnIndex === 1
    ? basePromptFile
    : join(workspacePath, `symphifo-turn-${String(turnIndex).padStart(2, "0")}.md`);

  if (turnIndex > 1) {
    writeFileSync(turnPromptFile, `${turnPrompt}\n`, "utf8");
  }

  session.status = "running";
  session.lastPrompt = turnPrompt;
  session.lastPromptFile = turnPromptFile;
  session.maxTurns = maxTurns;
  await persistAgentSessionState(sessionKey, issue, provider, cycle, session);

  const turnStartedAt = now();
  const turnEnv = {
    SYMPHIFO_AGENT_PROVIDER: provider.provider,
    SYMPHIFO_AGENT_ROLE: provider.role,
    SYMPHIFO_SESSION_KEY: sessionKey,
    SYMPHIFO_SESSION_ID: `${issue.id}-attempt-${attempt}`,
    SYMPHIFO_TURN_INDEX: String(turnIndex),
    SYMPHIFO_MAX_TURNS: String(maxTurns),
    SYMPHIFO_TURN_PROMPT: turnPrompt,
    SYMPHIFO_TURN_PROMPT_FILE: turnPromptFile,
    SYMPHIFO_CONTINUE: turnIndex > 1 ? "1" : "0",
    SYMPHIFO_PREVIOUS_OUTPUT: previousOutput,
    SYMPHIFO_RESULT_FILE: resultFile,
    SYMPHIFO_AGENT_PROFILE: provider.profile,
    SYMPHIFO_AGENT_PROFILE_FILE: provider.profilePath,
    SYMPHIFO_AGENT_PROFILE_INSTRUCTIONS: provider.profileInstructions,
  };

  if (workflowDefinition?.beforeRunHook) {
    await runHook(workflowDefinition.beforeRunHook, workspacePath, issue, "before_run", turnEnv);
  }

  addEvent(state, issue.id, "runner", `Turn ${turnIndex}/${maxTurns} started for ${issue.identifier}.`);

  const turnResult = await runCommandWithTimeout(
    provider.command,
    workspacePath,
    issue,
    state.config,
    turnPrompt,
    turnPromptFile,
    turnEnv,
  );

  if (workflowDefinition?.afterRunHook) {
    await runHook(workflowDefinition.afterRunHook, workspacePath, issue, "after_run", {
      ...turnEnv,
      SYMPHIFO_LAST_EXIT_CODE: String(turnResult.code ?? ""),
      SYMPHIFO_LAST_OUTPUT: turnResult.output,
      SYMPHIFO_PRESERVE_RESULT_FILE: "1",
    });
  }

  const directive = readAgentDirective(workspacePath, turnResult.output, turnResult.success);
  lastCode = turnResult.code;
  lastOutput = turnResult.output;
  previousOutput = turnResult.output;
  nextPrompt = directive.nextPrompt;
  session.turns.push({
    turn: turnIndex,
    startedAt: turnStartedAt,
    completedAt: now(),
    promptFile: turnPromptFile,
    prompt: turnPrompt,
    output: turnResult.output,
    code: turnResult.code,
    success: turnResult.success,
    directiveStatus: directive.status,
    directiveSummary: directive.summary,
    nextPrompt: directive.nextPrompt,
  });
  session.lastCode = lastCode;
  session.lastOutput = lastOutput;
  session.lastDirectiveStatus = directive.status;
  session.lastDirectiveSummary = directive.summary;
  session.nextPrompt = nextPrompt;

  const directiveSummary = directive.summary ? ` ${directive.summary}` : "";
  addEvent(
    state,
    issue.id,
    "runner",
    `Turn ${turnIndex}/${maxTurns} finished with status ${directive.status}.${directiveSummary}`.trim(),
  );

  if (!turnResult.success || directive.status === "failed") {
    session.status = "failed";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return {
      success: false,
      blocked: false,
      continueRequested: false,
      code: lastCode,
      output: lastOutput,
      turns: turnIndex,
    };
  }

  if (directive.status === "blocked") {
    session.status = "blocked";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return {
      success: false,
      blocked: true,
      continueRequested: false,
      code: lastCode,
      output: lastOutput,
      turns: turnIndex,
    };
  }

  if (directive.status === "continue") {
    session.status = "running";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return {
      success: false,
      blocked: false,
      continueRequested: true,
      code: lastCode,
      output: lastOutput,
      turns: turnIndex,
    };
  }

  session.status = "done";
  await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
  return {
    success: true,
    blocked: false,
    continueRequested: false,
    code: lastCode,
    output: lastOutput,
    turns: turnIndex,
  };
}

async function runAgentPipeline(
  state: RuntimeState,
  issue: IssueEntry,
  workspacePath: string,
  basePromptText: string,
  basePromptFile: string,
): Promise<AgentSessionResult> {
  const providers = getEffectiveAgentProviders(state);
  const attempt = issue.attempts + 1;
  const { pipeline, key: pipelineFile } = await loadAgentPipelineState(issue, attempt, providers);
  const activeProvider = providers[clamp(pipeline.activeIndex, 0, Math.max(0, providers.length - 1))];
  const executorIndex = providers.findIndex((provider) => provider.role === "executor");
  const providerPrompt = buildProviderBasePrompt(activeProvider, issue, basePromptText, workspacePath);

  if (!activeProvider.command.trim()) {
    throw new Error(`No command configured for provider ${activeProvider.provider} (${activeProvider.role}).`);
  }

  pipeline.history.push(`[${now()}] Running ${activeProvider.role}:${activeProvider.provider} in cycle ${pipeline.cycle}.`);
  await persistAgentPipelineState(pipelineFile, pipeline);

  const result = await runAgentSession(
    state,
    issue,
    activeProvider,
    pipeline.cycle,
    workspacePath,
    providerPrompt,
    basePromptFile,
  );

  if (result.success) {
    if (pipeline.activeIndex < providers.length - 1) {
      pipeline.activeIndex += 1;
      pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} completed; advancing to next provider.`);
      await persistAgentPipelineState(pipelineFile, pipeline);
      return {
        success: false,
        blocked: false,
        continueRequested: true,
        code: result.code,
        output: result.output,
        turns: result.turns,
      };
    }

    pipeline.history.push(`[${now()}] Final provider ${activeProvider.role}:${activeProvider.provider} completed the issue.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  if (result.continueRequested && activeProvider.role === "reviewer" && executorIndex >= 0) {
    pipeline.cycle += 1;
    pipeline.activeIndex = executorIndex;
    pipeline.history.push(`[${now()}] Reviewer requested rework; returning to executor for cycle ${pipeline.cycle}.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  if (result.continueRequested) {
    pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} requested another turn.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  if (result.blocked) {
    pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} blocked the pipeline.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} failed the pipeline.`);
  await persistAgentPipelineState(pipelineFile, pipeline);
  return result;
}

async function runIssueOnce(state: RuntimeState, issue: IssueEntry, running: Set<string>) {
  const startTs = Date.now();
  const resuming = issue.state === "In Progress";
  running.add(issue.id);
  state.metrics.activeWorkers += 1;
  issue.startedAt = issue.startedAt ?? now();

  if (resuming) {
    issue.updatedAt = now();
    issue.history.push(`[${issue.updatedAt}] Resuming persisted runner for ${issue.identifier}.`);
    addEvent(state, issue.id, "progress", `Runner resumed for ${issue.identifier}.`);
  } else {
    transition(issue, "In Progress", `Starting local runner for ${issue.identifier}.`);
    state.metrics.inProgress += 1;
    state.metrics.queued = Math.max(state.metrics.queued - 1, 0);
    addEvent(state, issue.id, "progress", `Runner started for ${issue.identifier}.`);
  }

  try {
    const { workspacePath, promptText, promptFile } = await prepareWorkspace(issue);
    addEvent(state, issue.id, "info", `Workspace ready at ${workspacePath}.`);

    const runResult = await runAgentPipeline(state, issue, workspacePath, promptText, promptFile);

    const duration = now();
    issue.durationMs = (Date.now() - startTs);
    issue.commandExitCode = runResult.code;
    issue.commandOutputTail = runResult.output;

    if (runResult.success) {
      transition(issue, "In Review", `Agent session finished successfully in ${runResult.turns} turn(s) for ${issue.identifier}.`);
      issue.lastError = undefined;
      await sleep(250);
      transition(issue, "Done", `Issue accepted by local review stage.`);
      addEvent(state, issue.id, "runner", `Issue ${issue.identifier} moved to Done.`);
      issue.completedAt = duration;
    } else if (runResult.continueRequested) {
      issue.updatedAt = now();
      issue.commandExitCode = runResult.code;
      issue.commandOutputTail = runResult.output;
      issue.lastError = undefined;
      issue.history.push(`[${issue.updatedAt}] Agent requested another turn (${runResult.turns}/${state.config.maxTurns}).`);
      addEvent(state, issue.id, "runner", `Issue ${issue.identifier} queued for next turn.`);
    } else {
      issue.lastError = runResult.output;
      issue.attempts += 1;

      if (issue.attempts >= issue.maxAttempts) {
        issue.commandExitCode = runResult.code;
        transition(issue, "Cancelled", `Max attempts reached (${issue.attempts}/${issue.maxAttempts}).`);
        addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled after repeated failures.`);
      } else {
        issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
        transition(
          issue,
          "Blocked",
          `${runResult.blocked ? "Agent requested manual intervention" : "Failure"} on attempt ${issue.attempts}/${issue.maxAttempts}; retry scheduled at ${issue.nextRetryAt}.`,
        );
        addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked waiting for retry.`);
      }
    }
  } catch (error) {
    issue.attempts += 1;
    issue.lastError = String(error);

    if (issue.attempts >= issue.maxAttempts) {
      transition(issue, "Cancelled", `Issue failed unexpectedly: ${issue.lastError}`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled unexpectedly.`);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      transition(issue, "Blocked", `Unexpected failure. Retry scheduled at ${issue.nextRetryAt}.`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked after unexpected failure.`);
    }
  } finally {
    issue.updatedAt = now();
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers - 1, 0);
    running.delete(issue.id);
    state.metrics = computeMetrics(state.issues);
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers, 0);
    state.updatedAt = now();
    await persistState(state);
  }

  return;
}

function ensureNotStale(state: RuntimeState, staleTimeoutMs: number) {
  const limit = Date.now() - staleTimeoutMs;
  for (const issue of state.issues) {
    if (
      EXECUTING_STATES.has(issue.state)
      && Date.parse(issue.updatedAt) < limit
      && !TERMINAL_STATES.has(issue.state)
      && !issueHasResumableSession(issue)
    ) {
      issue.attempts += 1;
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      issue.startedAt = undefined;
      transition(issue, "Blocked", `Issue state auto-recovered from stale execution.`);
    }
  }
}

function pickNextIssues(state: RuntimeState, running: Set<string>): IssueEntry[] {
  const queued = state.issues
    .filter((issue) => canRunIssue(issue, running, state))
    .sort((a, b) => {
      const stateWeight = (candidate: IssueEntry) => candidate.state === "In Progress" ? 0 : candidate.state === "Blocked" ? 2 : 1;
      const weightDiff = stateWeight(a) - stateWeight(b);
      if (weightDiff !== 0) {
        return weightDiff;
      }
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });

  return queued;
}

function hasTerminalQueue(state: RuntimeState): boolean {
  return state.issues.every((issue) => TERMINAL_STATES.has(issue.state) || issue.attempts >= issue.maxAttempts);
}

function handleStatePatch(state: RuntimeState, issue: IssueEntry, payload: JsonRecord) {
  const nextState = normalizeState(payload.state);
  const allowed = new Set([...ALLOWED_STATES]);

  if (!allowed.has(nextState)) {
    throw new Error(`Unsupported state: ${String(payload.state)}`);
  }

  transition(issue, nextState, `Manual state update: ${nextState}`);
  if (nextState === "Todo") {
    issue.nextRetryAt = undefined;
    issue.lastError = undefined;
  }

  if (nextState === "Cancelled") {
    issue.lastError = toStringValue(payload.reason);
  }

  addEvent(state, issue.id, "manual", `Manual state transition to ${nextState}`);
}

async function startApiServer(state: RuntimeState, port: number) {
  if (!stateDb) {
    fail("Cannot start API plugin before the database is initialized.");
  }

  const { ApiPlugin } = await loadS3dbModule();
  const indexHtml = readTextOrNull(FRONTEND_INDEX) ?? "";
  const appJs = readTextOrNull(FRONTEND_APP_JS) ?? "";
  const stylesCss = readTextOrNull(FRONTEND_STYLES_CSS) ?? "";

  const fallback = `<!doctype html><html><body><pre>Unable to load Symphifo dashboard assets.</pre></body></html>`;
  const findIssue = (issueId: string) => state.issues.find((candidate) => candidate.id === issueId || candidate.identifier === issueId);
  const apiPlugin = new ApiPlugin({
    port,
    host: "0.0.0.0",
    versionPrefix: false,
    docs: {
      enabled: true,
      title: "Symphifo API",
      version: "1.0.0",
      description: "Local orchestration API for Symphifo",
    },
    cors: { enabled: true, origin: "*" },
    logging: {
      enabled: true,
      excludePaths: ["/health", "/api/health"],
    },
    compression: { enabled: true, threshold: 1024 },
    health: { enabled: true },
    resources: {
      [S3DB_RUNTIME_RESOURCE]: { auth: false, methods: ["GET", "HEAD", "OPTIONS"] },
      [S3DB_ISSUE_RESOURCE]: { auth: false, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
      [S3DB_EVENT_RESOURCE]: { auth: false, methods: ["GET", "HEAD", "OPTIONS"] },
      [S3DB_AGENT_SESSION_RESOURCE]: { auth: false, methods: ["GET", "HEAD", "OPTIONS"] },
      [S3DB_AGENT_PIPELINE_RESOURCE]: { auth: false, methods: ["GET", "HEAD", "OPTIONS"] },
    },
    routes: {
      "GET /api/state": async () => state,
      "GET /api/health": async () => ({
        status: "ok",
        updatedAt: state.updatedAt,
        config: state.config,
        trackerKind: state.trackerKind,
      }),
      "GET /api/issues": async () => ({ issues: state.issues }),
      "POST /api/issues": async (c) => {
        const payload = await c.req.json() as JsonRecord;
        const issue = createIssueFromPayload(payload, state.issues);
        const duplicate = state.issues.find((candidate) => candidate.id === issue.id || candidate.identifier === issue.identifier);

        if (duplicate) {
          return c.json({ ok: false, error: "Issue id or identifier already exists", issue: duplicate }, 409);
        }

        state.issues.push(issue);
        state.updatedAt = now();
        addEvent(state, issue.id, "manual", `Issue ${issue.identifier} created via API.`);
        await persistState(state);
        return c.json({ ok: true, issue }, 201);
      },
      "GET /api/events": async (c) => {
        const since = c.req.query("since");
        const events = typeof since === "string" ? state.events.filter((entry) => entry.at > since) : state.events;
        return { events: events.slice(0, 200) };
      },
      "GET /api/issue/:id/pipeline": async (c) => {
        const issue = findIssue(c.req.param("id"));
        if (!issue) {
          return c.json({ ok: false, error: "Issue not found" }, 404);
        }

        const providers = getEffectiveAgentProviders(state);
        const pipeline = await loadAgentPipelineSnapshotForIssue(issue, providers);
        return { ok: true, issueId: issue.id, pipeline };
      },
      "GET /api/issue/:id/sessions": async (c) => {
        const issue = findIssue(c.req.param("id"));
        if (!issue) {
          return c.json({ ok: false, error: "Issue not found" }, 404);
        }

        const providers = getEffectiveAgentProviders(state);
        const pipeline = await loadAgentPipelineSnapshotForIssue(issue, providers);
        const sessions = await loadAgentSessionSnapshotsForIssue(issue, providers, pipeline);
        return { ok: true, issueId: issue.id, pipeline, sessions };
      },
      "POST /api/issue/:id/state": async (c) => {
        const issue = findIssue(c.req.param("id"));
        if (!issue) {
          return c.json({ ok: false, error: "Issue not found" }, 404);
        }

        const payload = await c.req.json() as JsonRecord;
        try {
          handleStatePatch(state, issue, payload);
          await persistState(state);
          return { ok: true, issue };
        } catch (error) {
          return c.json({ ok: false, error: String(error) }, 400);
        }
      },
      "POST /api/issue/:id/retry": async (c) => {
        const issue = findIssue(c.req.param("id"));
        if (!issue) {
          return c.json({ ok: false, error: "Issue not found" }, 404);
        }

        if (TERMINAL_STATES.has(issue.state)) {
          issue.state = "Todo";
          issue.attempts = Math.max(0, issue.attempts - 1);
          issue.lastError = undefined;
          issue.nextRetryAt = undefined;
          transition(issue, "Todo", "Manual retry requested.");
        } else {
          issue.nextRetryAt = undefined;
          issue.lastError = undefined;
        }

        addEvent(state, issue.id, "manual", `Manual retry requested for ${issue.id}.`);
        await persistState(state);
        return { ok: true, issue };
      },
      "POST /api/issue/:id/cancel": async (c) => {
        const issue = findIssue(c.req.param("id"));
        if (!issue) {
          return c.json({ ok: false, error: "Issue not found" }, 404);
        }

        transition(issue, "Cancelled", "Manual cancel requested.");
        addEvent(state, issue.id, "manual", `Manual cancel requested for ${issue.id}.`);
        await persistState(state);
        return { ok: true, issue };
      },
      "GET /state": async (c) => c.redirect("/api/state"),
      "GET /": async (c) => c.html(indexHtml || fallback),
      "GET /index.html": async (c) => c.html(indexHtml || fallback),
      "GET /assets/app.js": async (c) => c.body(appJs || "console.log('Dashboard script not found.');", 200, {
        "content-type": "application/javascript; charset=utf-8",
      }),
      "GET /assets/styles.css": async (c) => c.body(stylesCss || "", 200, {
        "content-type": "text/css; charset=utf-8",
      }),
    },
  });
  activeApiPlugin = await stateDb.usePlugin(apiPlugin, "api") as { stop?: () => Promise<void> };
  log(`Local dashboard available at http://localhost:${port}`);
  log(`State API: http://localhost:${port}/api/state`);
  log(`OpenAPI docs available at http://localhost:${port}/docs`);
}

async function scheduler(state: RuntimeState, running: Set<string>, runForever: boolean) {
  if (runForever) {
    while (true) {
      ensureNotStale(state, state.config.staleInProgressTimeoutMs);
      const ready = pickNextIssues(state, running);
      const slots = state.config.workerConcurrency - running.size;
      if (slots > 0) {
        const next = ready.slice(0, Math.max(0, slots));
        await Promise.all(next.map((issue) => runIssueOnce(state, issue, running)));
      }

      state.updatedAt = now();
      await persistState(state);
      addEvent(state, undefined, "info", "Scheduler tick completed.");
      await sleep(state.config.pollIntervalMs);
    }
  }

  while (!hasTerminalQueue(state)) {
    ensureNotStale(state, state.config.staleInProgressTimeoutMs);
    const ready = pickNextIssues(state, running);
    const slots = state.config.workerConcurrency - running.size;
    const next = ready.slice(0, Math.max(0, slots));

    if (next.length === 0 && running.size === 0) {
      if (state.issues.some((issue) => issue.state === "Blocked" && issue.nextRetryAt && issue.attempts < issue.maxAttempts)) {
        await sleep(state.config.pollIntervalMs);
        continue;
      }
      break;
    }

    await Promise.all(next.map((issue) => runIssueOnce(state, issue, running)));
    state.updatedAt = now();
    await persistState(state);

    if (running.size === 0) {
      await sleep(state.config.pollIntervalMs);
    }
  }
}

function usage() {
  console.log(`Usage: ${argv[1]} [options]\n` +
    "Options:\n" +
    "  --workspace <path>     Target workspace root (default: current directory)\n" +
    "  --persistence <path>   Persistence root (default: current directory)\n" +
    "  --port <n>             Start local dashboard\n" +
    "  --concurrency <n>      Maximum number of local workers\n" +
    "  --attempts <n>         Maximum attempts per issue\n" +
    "  --poll <ms>            Scheduler interval in ms\n" +
    "  --once                  Process once and exit\n");
}

async function main() {
  debugBoot("main:start");
  if (TRACKER_KIND !== "filesystem") {
    fail("SYMPHIFO_TRACKER_KIND must be 'filesystem' for this fork.");
  }

  const args = CLI_ARGS;
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const interfaceMode = (env.SYMPHIFO_INTERFACE ?? "cli").trim().toLowerCase();
  const runOnce = args.includes("--once");
  mkdirSync(STATE_ROOT, { recursive: true });
  debugBoot("main:state-root-ready");
  workflowDefinition = loadWorkflowDefinition();
  debugBoot("main:workflow-loaded");
  const port = parsePort(args);
  const config = applyWorkflowConfig(deriveConfig(args), workflowDefinition, port);
  const dashboardPort = port ?? (config.dashboardPort ? Number.parseInt(config.dashboardPort, 10) : undefined);

  bootstrapSource();
  debugBoot("main:source-bootstrapped");
  await initStateStore();
  debugBoot("main:store-initialized");

  const seedIssues = loadSeedIssues(LOCAL_ISSUES_FILE);
  debugBoot("main:seed-loaded");
  const previous = await loadPersistedState();
  debugBoot("main:state-loaded");
  const state = mergeStateWithSeed(seedIssues, previous, config, workflowDefinition);
  debugBoot("main:state-merged");

  state.config.dashboardPort = dashboardPort ? String(dashboardPort) : undefined;
  state.workflowPath = WORKFLOW_RENDERED;
  state.updatedAt = now();

  if (state.config.agentCommand) {
    state.notes.push(`Using external Codex local command: ${state.config.agentCommand}`);
  }
  state.notes.push(`Agent session max turns: ${state.config.maxTurns}`);
  state.notes.push(`Agent provider: ${state.config.agentProvider}`);
  state.notes.push(`Interface mode: ${interfaceMode}`);

  if (!state.config.agentCommand.trim()) {
    debugBoot("main:missing-agent-command");
    fail("No agent command configured. Set SYMPHIFO_AGENT_COMMAND or configure codex.command / claude.command in WORKFLOW.md.");
  }

  state.metrics = computeMetrics(state.issues);
  await persistState(state);

  const running = new Set<string>();
  log(`Rendered local workflow: ${WORKFLOW_RENDERED}`);
  log(`Loaded issues: ${state.issues.length}`);
  log(`Worker concurrency: ${state.config.workerConcurrency}`);
  log(`Max attempts: ${state.config.maxAttemptsDefault}`);
  log(`Max turns: ${state.config.maxTurns}`);
  log(`Agent provider: ${state.config.agentProvider}`);
  log(`Interface mode: ${interfaceMode}`);

  if (dashboardPort) {
    await startApiServer(state, dashboardPort);
  }

  try {
    addEvent(state, undefined, "info", `Runtime started in local-only mode (filesystem tracker).`);
    const runForever = !runOnce && (Boolean(dashboardPort) || interfaceMode === "mcp");
    await scheduler(state, running, runForever);
  } catch (error) {
    addEvent(state, undefined, "error", `Fatal runtime error: ${String(error)}`);
    await persistState(state);
    throw error;
  } finally {
    state.updatedAt = now();
    state.metrics = computeMetrics(state.issues);
    await persistState(state);
    await closeStateStore();
  }
}

main().catch((error) => {
  console.error("Fatal runtime error", error);
  exit(1);
});
