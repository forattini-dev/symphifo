import { S3DB_ISSUE_RESOURCE } from "../constants.ts";
import type { JsonRecord, RuntimeState } from "../types.ts";
import { TERMINAL_STATES } from "../constants.ts";
import { loadAgentPipelineSnapshotForIssue, loadAgentSessionSnapshotsForIssue } from "../agent.ts";
import { getApiRuntimeContextOrThrow } from "../api-runtime-context.ts";
import { persistState } from "../store.ts";
import { getEffectiveAgentProviders } from "../providers.ts";
import { addEvent, createIssueFromPayload, handleStatePatch, transition } from "../issues.ts";
import { now } from "../helpers.ts";

function getIssueId(c: unknown): string | null {
  if (!c || typeof c !== "object" || !("req" in c) || !c.req || typeof (c as { req: unknown }).req !== "object") {
    return null;
  }
  const req = (c as { req: { param: (name: string) => unknown } }).req;
  const value = req.param("id");
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function findIssue(state: RuntimeState, issueId: string) {
  return state.issues.find((issue) => issue.id === issueId || issue.identifier === issueId);
}

async function getIssuePipeline(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  const providers = getEffectiveAgentProviders(context.state, issue, context.workflowDefinition);
  const pipeline = await loadAgentPipelineSnapshotForIssue(issue, providers);
  return { body: { ok: true, issueId: issue.id, pipeline } };
}

async function getIssueSessions(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  const providers = getEffectiveAgentProviders(context.state, issue, context.workflowDefinition);
  const pipeline = await loadAgentPipelineSnapshotForIssue(issue, providers);
  const sessions = await loadAgentSessionSnapshotsForIssue(issue, providers, pipeline, context.workflowDefinition);
  return { body: { ok: true, issueId: issue.id, pipeline, sessions } };
}

async function patchIssueState(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  try {
    const payload = await (c as { req: { json: () => Promise<unknown> } }).req.json() as JsonRecord;
    handleStatePatch(context.state, issue, payload);
    await persistState(context.state);
    return { body: { ok: true, issue } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function retryIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  if (TERMINAL_STATES.has(issue.state)) {
    issue.state = "Todo";
    issue.attempts = Math.max(0, issue.attempts - 1);
    issue.lastError = undefined;
    issue.nextRetryAt = undefined;
    issue.updatedAt = now();
    transition(issue, "Todo", "Manual retry requested.");
  } else {
    issue.nextRetryAt = undefined;
    issue.lastError = undefined;
    issue.updatedAt = now();
  }

  addEvent(context.state, issue.id, "manual", `Manual retry requested for ${issue.id}.`);
  await persistState(context.state);
  return { body: { ok: true, issue } };
}

async function createIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  try {
    const payload = await (c as { req: { json: () => Promise<unknown> } }).req.json() as JsonRecord;
    const issue = createIssueFromPayload(payload, context.state.issues, context.workflowDefinition);
    context.state.issues.push(issue);
    addEvent(context.state, issue.id, "info", `Issue ${issue.identifier} created via API.`);
    await persistState(context.state);
    return { body: { ok: true, issue } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function cancelIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  transition(issue, "Cancelled", "Manual cancel requested.");
  addEvent(context.state, issue.id, "manual", `Manual cancel requested for ${issue.id}.`);
  await persistState(context.state);
  return { body: { ok: true, issue } };
}

export default {
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
    paths: "json|optional",
    inferredPaths: "json|optional",
    capabilityCategory: "string|optional",
    capabilityOverlays: "json|optional",
    capabilityRationale: "json|optional",
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
  partitions: {
    byState: { fields: { state: "string" } },
    byCapabilityCategory: { fields: { capabilityCategory: "string" } },
    byStateAndCapability: {
      fields: { state: "string", capabilityCategory: "string" },
    },
  },
  asyncPartitions: true,
  behavior: "body-overflow",
  paranoid: false,
  timestamps: true,
  api: {
    auth: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    description: "Issue registry for orchestration runtime",
    "POST /": async (c: unknown) => {
      const result = await createIssue(c);
      if (result.status) {
        return (c as any).json(result.body, result.status);
      }
      return (c as any).json(result.body, 201);
    },
    "GET /:id/pipeline": async (c: unknown) => {
      const result = await getIssuePipeline(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
    "GET /:id/sessions": async (c: unknown) => {
      const result = await getIssueSessions(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
    "POST /:id/state": async (c: unknown) => {
      const result = await patchIssueState(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
    "POST /:id/retry": async (c: unknown) => {
      const result = await retryIssue(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
    "POST /:id/cancel": async (c: unknown) => {
      const result = await cancelIssue(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
  },
};
