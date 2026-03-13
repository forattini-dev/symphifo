import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env, stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type IssueRecord = {
  id: string;
  identifier?: string;
  title: string;
  description?: string;
  priority?: number;
  state?: string;
  labels?: string[];
  url?: string;
  assigned_to_worker?: boolean;
  [key: string]: unknown;
};

type RuntimeSnapshot = {
  updatedAt?: string;
  config?: Record<string, unknown>;
  issues?: IssueRecord[];
  metrics?: Record<string, unknown>;
  notes?: string[];
  [key: string]: unknown;
};

type S3dbResource = {
  insert: (record: Record<string, unknown>) => Promise<Record<string, unknown>>;
  get: (id: string) => Promise<Record<string, unknown> | null>;
  update: (id: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  list: (options?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  query?: (options?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
};

type S3dbDatabase = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  createResource: (config: Record<string, unknown>) => Promise<S3dbResource>;
  resources: Record<string, S3dbResource>;
};

type S3dbModule = {
  default: new (config: Record<string, unknown>) => S3dbDatabase;
  FileSystemClient: new (config: Record<string, unknown>) => unknown;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "../..");
const WORKSPACE_ROOT = resolve(env.SYMPHIFO_WORKSPACE_ROOT ?? process.cwd());
const PERSISTENCE_ROOT = resolve(env.SYMPHIFO_PERSISTENCE ?? WORKSPACE_ROOT);
const STATE_ROOT = join(PERSISTENCE_ROOT, ".symphifo");
const DATABASE_PATH = join(STATE_ROOT, "s3db");
const WORKFLOW_PATH = join(WORKSPACE_ROOT, "WORKFLOW.md");
const README_PATH = join(PACKAGE_ROOT, "README.md");
const SYMPHIFO_GUIDE_PATH = join(PACKAGE_ROOT, "SYMPHIFO.md");
const STORAGE_BUCKET = env.SYMPHIFO_STORAGE_BUCKET ?? "symphifo";
const STORAGE_KEY_PREFIX = env.SYMPHIFO_STORAGE_KEY_PREFIX ?? "state";
const STORAGE_LIBRARY_PATH = env.SYMPHIFO_STORAGE_LIBRARY_PATH?.trim()
  ? resolve(env.SYMPHIFO_STORAGE_LIBRARY_PATH)
  : "";
const DEBUG_BOOT = env.SYMPHIFO_DEBUG_BOOT === "1";
const RUNTIME_RESOURCE = "symphifo_runtime_state";
const ISSUE_RESOURCE = "symphifo_issues";
const EVENT_RESOURCE = "symphifo_events";
const SESSION_RESOURCE = "symphifo_agent_sessions";
const PIPELINE_RESOURCE = "symphifo_agent_pipelines";
const RUNTIME_RECORD_ID = "current";

let incomingBuffer = Buffer.alloc(0);
let database: S3dbDatabase | null = null;
let runtimeResource: S3dbResource | null = null;
let issueResource: S3dbResource | null = null;
let eventResource: S3dbResource | null = null;
let sessionResource: S3dbResource | null = null;
let pipelineResource: S3dbResource | null = null;

function debugBoot(message: string): void {
  if (!DEBUG_BOOT) {
    return;
  }

  process.stderr.write(`[SYMPHIFO_DEBUG_BOOT] ${message}\n`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeRead(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function hashInput(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

async function loadS3dbModule(): Promise<S3dbModule> {
  const checkoutEntry = STORAGE_LIBRARY_PATH
    ? STORAGE_LIBRARY_PATH
    : join(homedir(), "Work", "tetis", "libs", "s3db.js", "dist", "index.js");
  const candidates = [
    {
      entry: "s3db.js",
      clients: "s3db.js/clients/index",
    },
    ...(checkoutEntry
      ? [{
          entry: pathToFileURL(checkoutEntry).href,
          clients: pathToFileURL(checkoutEntry.replace(/dist\/index\.js$/, "dist/clients/index.js")).href,
        }]
      : []),
  ];

  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const imported = await import(candidate.entry);
      const filesystemModule = await import(candidate.clients);

      return {
        default: imported.default,
        FileSystemClient: filesystemModule.FileSystemClient,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Unable to load s3db.js. Last error: ${String(lastError)}`);
}

async function getDatabase(): Promise<S3dbDatabase> {
  if (database) {
    return database;
  }

  debugBoot("mcp:getDatabase:start");
  const s3db = await loadS3dbModule();
  debugBoot("mcp:getDatabase:module-loaded");
  const client = new s3db.FileSystemClient({
    basePath: DATABASE_PATH,
    bucket: STORAGE_BUCKET,
    keyPrefix: STORAGE_KEY_PREFIX,
    verbose: false,
  });

  database = new s3db.default({
    client,
    verbose: false,
  });

  await database.connect();
  debugBoot("mcp:getDatabase:connected");

  runtimeResource = database.resources[RUNTIME_RESOURCE] ?? await database.createResource({
    name: RUNTIME_RESOURCE,
    behavior: "body-overflow",
    attributes: {
      updatedAt: "datetime|required",
      state: "json|required",
    },
  });

  issueResource = database.resources[ISSUE_RESOURCE] ?? await database.createResource({
    name: ISSUE_RESOURCE,
    behavior: "body-overflow",
    attributes: {
      id: "string|required",
      identifier: "string|required",
      title: "string|required",
      description: "string|optional",
      priority: "number|required",
      state: "string|required",
      branchName: "string|optional",
      labels: "json|required",
      blockedBy: "json|required",
      assignedToWorker: "boolean|required",
      createdAt: "datetime|required",
      updatedAt: "datetime|required",
      history: "json|required",
      attempts: "number|required",
      maxAttempts: "number|required",
      url: "string|optional",
      assigneeId: "string|optional",
      startedAt: "datetime|optional",
      completedAt: "datetime|optional",
      nextRetryAt: "datetime|optional",
      workspacePath: "string|optional",
      workspacePreparedAt: "datetime|optional",
      lastError: "string|optional",
      durationMs: "number|optional",
      commandExitCode: "number|optional",
      commandOutputTail: "string|optional",
    },
  });

  eventResource = database.resources[EVENT_RESOURCE] ?? await database.createResource({
    name: EVENT_RESOURCE,
    behavior: "body-overflow",
    attributes: {
      id: "string|required",
      issueId: "string|optional",
      kind: "string|required",
      message: "string|required",
      at: "datetime|required",
    },
  });

  sessionResource = database.resources[SESSION_RESOURCE] ?? await database.createResource({
    name: SESSION_RESOURCE,
    behavior: "body-overflow",
    attributes: {
      id: "string|required",
      issueId: "string|required",
      issueIdentifier: "string|required",
      attempt: "number|required",
      provider: "string|required",
      role: "string|required",
      cycle: "number|required",
      session: "json|required",
      updatedAt: "datetime|required",
    },
  });

  pipelineResource = database.resources[PIPELINE_RESOURCE] ?? await database.createResource({
    name: PIPELINE_RESOURCE,
    behavior: "body-overflow",
    attributes: {
      id: "string|required",
      issueId: "string|required",
      issueIdentifier: "string|required",
      attempt: "number|required",
      pipeline: "json|required",
      updatedAt: "datetime|required",
    },
  });

  debugBoot("mcp:getDatabase:resources-ready");

  return database;
}

async function listRecords(resource: S3dbResource | null, limit: number = 100): Promise<Record<string, unknown>[]> {
  if (!resource) {
    return [];
  }

  if (typeof resource.query === "function") {
    return await resource.query({});
  }

  return await resource.list({ limit });
}

async function getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  await getDatabase();
  const record = await runtimeResource?.get(RUNTIME_RECORD_ID);
  const state = record?.state;
  if (state && typeof state === "object") {
    return state as RuntimeSnapshot;
  }
  return {};
}

async function getIssues(): Promise<IssueRecord[]> {
  await getDatabase();
  const records = await listRecords(issueResource, 500);
  return records.map((record) => record as IssueRecord);
}

async function getIssue(issueId: string): Promise<IssueRecord | null> {
  await getDatabase();
  const issue = await issueResource?.get(issueId);
  return (issue as IssueRecord | null) ?? null;
}

async function appendEvent(level: string, message: string, payload: Record<string, unknown> = {}, issueId?: string): Promise<void> {
  await getDatabase();
  await eventResource?.insert({
    id: randomUUID(),
    issueId,
    kind: level,
    message,
    at: nowIso(),
  });
}

function buildIntegrationGuide(): string {
  return [
    "# Symphifo MCP integration",
    "",
    `Workspace root: \`${WORKSPACE_ROOT}\``,
    `Persistence root: \`${PERSISTENCE_ROOT}\``,
    `State root: \`${STATE_ROOT}\``,
    "",
    "Recommended MCP client command:",
    "",
    "```json",
    "{",
    '  "mcpServers": {',
    '    "symphifo": {',
    '      "command": "npx",',
    `      "args": ["symphifo", "mcp", "--workspace", "${WORKSPACE_ROOT}", "--persistence", "${PERSISTENCE_ROOT}"]`,
    "    }",
    "  }",
    "}",
    "```",
    "",
    "Expected workflow:",
    "",
    "1. Read `symphifo://guide/overview` and `symphifo://state/summary`.",
    "2. Use `symphifo.list_issues` or read `symphifo://issues`.",
    "3. Create work with `symphifo.create_issue`.",
    "4. Update workflow state with `symphifo.update_issue_state`.",
    "5. Use the prompts exposed by this MCP server to structure planning or execution.",
    "",
    "The MCP server is read-write against the same `s3db` filesystem store used by the Symphifo runtime.",
  ].join("\n");
}

async function buildStateSummary(): Promise<string> {
  const runtime = await getRuntimeSnapshot();
  const issues = await getIssues();
  const sessions = await listRecords(sessionResource, 500);
  const pipelines = await listRecords(pipelineResource, 500);
  const events = await listRecords(eventResource, 100);

  const byState = issues.reduce<Record<string, number>>((accumulator, issue) => {
    const key = issue.state ?? "Unknown";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});

  return JSON.stringify({
    workspaceRoot: WORKSPACE_ROOT,
    persistenceRoot: PERSISTENCE_ROOT,
    stateRoot: STATE_ROOT,
    workflowPresent: existsSync(WORKFLOW_PATH),
    runtimeUpdatedAt: runtime.updatedAt ?? null,
    issueCount: issues.length,
    issuesByState: byState,
    sessionCount: sessions.length,
    pipelineCount: pipelines.length,
    recentEventCount: events.length,
  }, null, 2);
}

function buildIssuePrompt(issue: IssueRecord, provider: string, role: string): string {
  return [
    `You are integrating with Symphifo as the ${role} using ${provider}.`,
    "",
    `Issue ID: ${issue.id}`,
    `Title: ${issue.title}`,
    `State: ${issue.state ?? "Todo"}`,
    issue.description ? `Description:\n${issue.description}` : "Description:\nNo description provided.",
    "",
    "Use Symphifo as the source of truth:",
    "- Read the workflow contract from WORKFLOW.md if available.",
    "- Persist transitions through the Symphifo tools instead of inventing local state.",
    "- Keep outputs actionable and aligned with the tracked issue lifecycle.",
  ].join("\n");
}

async function listResources(): Promise<Array<Record<string, unknown>>> {
  const issues = await getIssues();
  const resources: Array<Record<string, unknown>> = [
    {
      uri: "symphifo://guide/overview",
      name: "Symphifo overview",
      description: "High-level overview and local integration guide.",
      mimeType: "text/markdown",
    },
    {
      uri: "symphifo://guide/runtime",
      name: "Symphifo runtime guide",
      description: "Detailed local runtime reference for the package.",
      mimeType: "text/markdown",
    },
    {
      uri: "symphifo://guide/integration",
      name: "Symphifo MCP integration guide",
      description: "How to wire an MCP client to this Symphifo workspace.",
      mimeType: "text/markdown",
    },
    {
      uri: "symphifo://state/summary",
      name: "Symphifo state summary",
      description: "Compact summary of the current runtime, issue, and pipeline state.",
      mimeType: "application/json",
    },
    {
      uri: "symphifo://issues",
      name: "Symphifo issues",
      description: "Full issue list from the durable Symphifo store.",
      mimeType: "application/json",
    },
  ];

  if (existsSync(WORKFLOW_PATH)) {
    resources.push({
      uri: "symphifo://workspace/workflow",
      name: "Workspace workflow",
      description: "The active WORKFLOW.md from the target workspace.",
      mimeType: "text/markdown",
    });
  }

  for (const issue of issues.slice(0, 100)) {
    resources.push({
      uri: `symphifo://issue/${encodeURIComponent(issue.id)}`,
      name: `Issue ${issue.id}`,
      description: issue.title,
      mimeType: "application/json",
    });
  }

  return resources;
}

async function readResource(uri: string): Promise<Array<Record<string, unknown>>> {
  if (uri === "symphifo://guide/overview") {
    return [{ uri, mimeType: "text/markdown", text: safeRead(README_PATH) }];
  }

  if (uri === "symphifo://guide/runtime") {
    return [{ uri, mimeType: "text/markdown", text: safeRead(SYMPHIFO_GUIDE_PATH) }];
  }

  if (uri === "symphifo://guide/integration") {
    return [{ uri, mimeType: "text/markdown", text: buildIntegrationGuide() }];
  }

  if (uri === "symphifo://state/summary") {
    return [{ uri, mimeType: "application/json", text: await buildStateSummary() }];
  }

  if (uri === "symphifo://issues") {
    return [{ uri, mimeType: "application/json", text: JSON.stringify(await getIssues(), null, 2) }];
  }

  if (uri === "symphifo://workspace/workflow") {
    return [{ uri, mimeType: "text/markdown", text: safeRead(WORKFLOW_PATH) }];
  }

  if (uri.startsWith("symphifo://issue/")) {
    const issueId = decodeURIComponent(uri.substring("symphifo://issue/".length));
    const issue = await getIssue(issueId);
    if (!issue) {
      throw new Error(`Issue not found: ${issueId}`);
    }
    return [{ uri, mimeType: "application/json", text: JSON.stringify(issue, null, 2) }];
  }

  throw new Error(`Unknown resource: ${uri}`);
}

function listPrompts(): Array<Record<string, unknown>> {
  return [
    {
      name: "symphifo-integrate-client",
      description: "Generate setup instructions for connecting an MCP-capable client to Symphifo.",
      arguments: [
        { name: "client", description: "Client name, e.g. codex or claude.", required: true },
        { name: "goal", description: "What the client should do with Symphifo.", required: false },
      ],
    },
    {
      name: "symphifo-plan-issue",
      description: "Generate a planning prompt for a specific issue in the Symphifo store.",
      arguments: [
        { name: "issueId", description: "Issue identifier.", required: true },
        { name: "provider", description: "Agent provider name.", required: false },
      ],
    },
    {
      name: "symphifo-review-workflow",
      description: "Review the current WORKFLOW.md and propose improvements for orchestration quality.",
      arguments: [
        { name: "provider", description: "Reviewing model or client.", required: false },
      ],
    },
  ];
}

async function getPrompt(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (name === "symphifo-integrate-client") {
    const client = typeof args.client === "string" && args.client.trim() ? args.client.trim() : "mcp-client";
    const goal = typeof args.goal === "string" && args.goal.trim() ? args.goal.trim() : "integrate with the local Symphifo workspace";
    return {
      description: "Client integration prompt for Symphifo.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Integrate ${client} with the local Symphifo MCP server.`,
              "",
              `Goal: ${goal}`,
              "",
              buildIntegrationGuide(),
              "",
              "Use the available Symphifo resources and tools instead of inventing your own persistence model.",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (name === "symphifo-plan-issue") {
    const issueId = typeof args.issueId === "string" ? args.issueId : "";
    const provider = typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : "codex";
    const issue = issueId ? await getIssue(issueId) : null;
    if (!issue) {
      throw new Error(`Issue not found: ${issueId}`);
    }
    return {
      description: "Issue planning prompt grounded in the Symphifo issue store.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildIssuePrompt(issue, provider, "planner"),
          },
        },
      ],
    };
  }

  if (name === "symphifo-review-workflow") {
    const provider = typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : "claude";
    return {
      description: "Workflow review prompt for Symphifo orchestration.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Review the WORKFLOW.md for this Symphifo workspace as ${provider}.`,
              "",
              `Workspace: ${WORKSPACE_ROOT}`,
              `Workflow present: ${existsSync(WORKFLOW_PATH) ? "yes" : "no"}`,
              "",
              "Focus on:",
              "- provider orchestration quality",
              "- hooks safety",
              "- prompt clarity",
              "- issue lifecycle correctness",
              "- what an MCP client needs in order to integrate cleanly",
            ].join("\n"),
          },
        },
      ],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
}

function listTools(): Array<Record<string, unknown>> {
  return [
    {
      name: "symphifo.status",
      description: "Return a compact status summary for the current Symphifo workspace.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "symphifo.list_issues",
      description: "List issues from the Symphifo durable store.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "symphifo.create_issue",
      description: "Create a new issue directly in the Symphifo durable store.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "number" },
          state: { type: "string" },
          labels: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    {
      name: "symphifo.update_issue_state",
      description: "Update an issue state in the Symphifo store and append an event.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          state: { type: "string" },
          note: { type: "string" },
        },
        required: ["issueId", "state"],
        additionalProperties: false,
      },
    },
    {
      name: "symphifo.integration_config",
      description: "Generate a ready-to-paste MCP client configuration snippet for this Symphifo workspace.",
      inputSchema: {
        type: "object",
        properties: {
          client: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  ];
}

function toolText(text: string): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (name === "symphifo.status") {
    return toolText(await buildStateSummary());
  }

  if (name === "symphifo.list_issues") {
    const issues = await getIssues();
    const stateFilter = typeof args.state === "string" && args.state.trim() ? args.state.trim() : "";
    const filtered = stateFilter ? issues.filter((issue) => issue.state === stateFilter) : issues;
    return toolText(JSON.stringify(filtered, null, 2));
  }

  if (name === "symphifo.create_issue") {
    await getDatabase();
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) {
      throw new Error("title is required");
    }

    const explicitId = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "";
    const issueId = explicitId || `LOCAL-${hashInput(`${title}:${nowIso()}`)}`.toUpperCase();
    const description = typeof args.description === "string" ? args.description : "";
    const priority = typeof args.priority === "number" ? args.priority : 2;
    const state = typeof args.state === "string" && args.state.trim() ? args.state.trim() : "Todo";
    const labels = Array.isArray(args.labels) ? args.labels.filter((value): value is string => typeof value === "string") : ["symphifo", "mcp"];

    const record = await issueResource?.insert({
      id: issueId,
      identifier: issueId,
      title,
      description,
      priority,
      state,
      labels,
      blockedBy: [],
      assignedToWorker: false,
      createdAt: nowIso(),
      url: `symphifo://local/${issueId}`,
      updatedAt: nowIso(),
      history: [`[${nowIso()}] Issue created via MCP.`],
      attempts: 0,
      maxAttempts: 3,
    });

    await appendEvent("info", `Issue ${issueId} created through MCP.`, { title, state, labels }, issueId);
    return toolText(JSON.stringify(record ?? { id: issueId }, null, 2));
  }

  if (name === "symphifo.update_issue_state") {
    await getDatabase();
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    const state = typeof args.state === "string" ? args.state.trim() : "";
    const note = typeof args.note === "string" ? args.note : "";

    if (!issueId || !state) {
      throw new Error("issueId and state are required");
    }

    const current = await issueResource?.get(issueId);
    if (!current) {
      throw new Error(`Issue not found: ${issueId}`);
    }

    const updated = await issueResource?.update(issueId, {
      state,
      updatedAt: nowIso(),
    });

    await appendEvent("info", note || `Issue ${issueId} moved to ${state} through MCP.`, { state }, issueId);
    return toolText(JSON.stringify(updated ?? { id: issueId, state }, null, 2));
  }

  if (name === "symphifo.integration_config") {
    const client = typeof args.client === "string" && args.client.trim() ? args.client.trim() : "client";
    return toolText(JSON.stringify({
      client,
      mcpServers: {
        symphifo: {
          command: "npx",
          args: ["symphifo", "mcp", "--workspace", WORKSPACE_ROOT, "--persistence", PERSISTENCE_ROOT],
        },
      },
    }, null, 2));
  }

  throw new Error(`Unknown tool: ${name}`);
}

function sendMessage(message: JsonRpcResponse): void {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  stdout.write(payload);
}

function sendResult(id: JsonRpcId, result: unknown): void {
  sendMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  });
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const id = request.id ?? null;

  try {
    switch (request.method) {
      case "initialize":
        sendResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            resources: {},
            tools: {},
            prompts: {},
          },
          serverInfo: {
            name: "symphifo",
            version: "0.1.0",
          },
        });
        return;
      case "notifications/initialized":
        return;
      case "ping":
        sendResult(id, {});
        return;
      case "resources/list":
        sendResult(id, { resources: await listResources() });
        return;
      case "resources/read":
        sendResult(id, { contents: await readResource(String(request.params?.uri ?? "")) });
        return;
      case "tools/list":
        sendResult(id, { tools: listTools() });
        return;
      case "tools/call":
        sendResult(id, await callTool(String(request.params?.name ?? ""), (request.params?.arguments as Record<string, unknown> | undefined) ?? {}));
        return;
      case "prompts/list":
        sendResult(id, { prompts: listPrompts() });
        return;
      case "prompts/get":
        sendResult(id, await getPrompt(String(request.params?.name ?? ""), (request.params?.arguments as Record<string, unknown> | undefined) ?? {}));
        return;
      default:
        sendError(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    sendError(id, -32000, String(error));
  }
}

function processIncomingBuffer(): void {
  while (true) {
    const separatorIndex = incomingBuffer.indexOf("\r\n\r\n");
    if (separatorIndex === -1) {
      return;
    }

    const headerText = incomingBuffer.subarray(0, separatorIndex).toString("utf8");
    const contentLengthHeader = headerText
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-length:"));

    if (!contentLengthHeader) {
      incomingBuffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number.parseInt(contentLengthHeader.split(":")[1]?.trim() ?? "0", 10);
    const messageStart = separatorIndex + 4;
    const messageEnd = messageStart + contentLength;

    if (incomingBuffer.length < messageEnd) {
      return;
    }

    const messageBody = incomingBuffer.subarray(messageStart, messageEnd).toString("utf8");
    incomingBuffer = incomingBuffer.subarray(messageEnd);

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(messageBody) as JsonRpcRequest;
    } catch (error) {
      sendError(null, -32700, `Invalid JSON: ${String(error)}`);
      continue;
    }

    void handleRequest(request);
  }
}

async function bootstrap(): Promise<void> {
  debugBoot("mcp:bootstrap:start");
  await getDatabase();
  debugBoot("mcp:bootstrap:database-ready");
  await appendEvent("info", "Symphifo MCP server started.", {
    workspaceRoot: WORKSPACE_ROOT,
    persistenceRoot: PERSISTENCE_ROOT,
  });

  stdin.on("data", (chunk: Buffer) => {
    incomingBuffer = Buffer.concat([incomingBuffer, chunk]);
    processIncomingBuffer();
  });

  stdin.resume();
  debugBoot("mcp:bootstrap:stdin-ready");
}

bootstrap().catch((error) => {
  sendError(null, -32001, `Failed to start Symphifo MCP server: ${String(error)}`);
  process.exit(1);
});

process.on("SIGINT", async () => {
  if (database) {
    await database.disconnect();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (database) {
    await database.disconnect();
  }
  process.exit(0);
});
