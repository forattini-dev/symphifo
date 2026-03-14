import type {
  JsonRecord,
  RuntimeEvent,
  RuntimeState,
  WorkflowDefinition,
} from "./types.ts";
import {
  FRONTEND_DIR,
  FRONTEND_INDEX,
} from "./constants.ts";
import { NATIVE_RESOURCE_CONFIGS } from "./resources/index.ts";
import { now, readTextOrNull, clamp } from "./helpers.ts";
import { logger } from "./logger.ts";
import {
  loadS3dbModule,
  getStateDb,
  getEventStateResource,
  setActiveApiPlugin,
  persistState,
} from "./store.ts";
import { addEvent, computeCapabilityCounts, computeMetrics } from "./issues.ts";
import { detectAvailableProviders } from "./providers.ts";
import { analyzeParallelizability } from "./scheduler.ts";
import { setApiRuntimeContext } from "./api-runtime-context.ts";

// ── WebSocket broadcast ──────────────────────────────────────────────────────

type WsClient = { send: (data: string) => void; readyState: number };
const wsClients = new Set<WsClient>();

export function broadcastToWebSocketClients(message: Record<string, unknown>): void {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === 1) {
      try { client.send(data); } catch {}
    }
  }
}

// ── API server ───────────────────────────────────────────────────────────────

export async function startApiServer(
  state: RuntimeState,
  port: number,
  workflowDefinition: WorkflowDefinition | null,
): Promise<void> {
  const stateDb = getStateDb();
  if (!stateDb) {
    throw new Error("Cannot start API plugin before the database is initialized.");
  }

  const s3dbModule = await loadS3dbModule();
  const { ApiPlugin } = s3dbModule;
  const fallbackHtml = `<!doctype html><html><body><pre>Unable to load Symphifo dashboard assets.</pre></body></html>`;
  const eventResource = getEventStateResource();

  const listEvents = async (filters: { issueId?: string; kind?: string; since?: string } = {}): Promise<RuntimeEvent[]> => {
    const { issueId, kind, since } = filters;

    let events: RuntimeEvent[];
    if (eventResource?.list) {
      const partition = issueId && kind ? "byIssueIdAndKind"
        : issueId ? "byIssueId"
        : kind ? "byKind"
        : null;
      const partitionValues = issueId && kind ? { issueId, kind }
        : issueId ? { issueId }
        : kind ? { kind }
        : {};
      events = (await eventResource.list({ partition, partitionValues, limit: 200 }))
        .map((record) => record as RuntimeEvent);
    } else {
      events = state.events.filter((event) => {
        if (issueId && event.issueId !== issueId) return false;
        if (kind && event.kind !== kind) return false;
        return true;
      });
    }

    return typeof since === "string" && since
      ? events.filter((entry) => entry.at > since)
      : events;
  };

  const resourceConfigs: Record<string, Record<string, unknown>> = Object.fromEntries(
    NATIVE_RESOURCE_CONFIGS.map((resourceConfig) => [
      resourceConfig.name,
      resourceConfig.api ?? {},
    ]),
  );
  const nativeResourceNames = new Set(Object.keys(resourceConfigs));

  const existingResources = await (stateDb as { listResources?: () => Promise<Array<{ name: string }>> }).listResources?.();
  for (const item of existingResources || []) {
    if (
      typeof item?.name === "string" &&
      item.name.startsWith("symphifo_") &&
      !nativeResourceNames.has(item.name)
    ) {
      resourceConfigs[item.name] = { enabled: false };
    }
  }

  setApiRuntimeContext(state, workflowDefinition);

  const websocketPort = port + 1;

  const apiPlugin = new ApiPlugin({
    port,
    host: "0.0.0.0",
    versionPrefix: false,
    rootRoute: (c: any) => c.html(readTextOrNull(FRONTEND_INDEX) || fallbackHtml),
    static: [{
      driver: "filesystem",
      path: "/assets",
      root: FRONTEND_DIR,
      config: { maxAge: 0, etag: true },
    }],
    docs: { enabled: true, title: "Symphifo API", version: "1.0.0", description: "Local orchestration API for Symphifo" },
    cors: { enabled: true, origin: "*" },
    security: { enabled: false },
    logging: { enabled: true, excludePaths: ["/health", "/status", "/assets", "/ws"] },
    compression: { enabled: true, threshold: 1024 },
    health: { enabled: true },
    resources: {
      ...resourceConfigs,
    },
    routes: {
      "GET /state": async (c: any) =>
        c.json({
          ...state,
          capabilities: computeCapabilityCounts(state.issues),
          websocketPort,
        }),
      "GET /status": async (c: any) =>
        c.json({
          status: "ok",
          updatedAt: state.updatedAt,
          config: state.config,
          trackerKind: state.trackerKind,
        }),
      "GET /providers": async (c: any) => {
        const providers = detectAvailableProviders();
        return c.json({ providers });
      },
      "GET /parallelism": async (c: any) => {
        return c.json(analyzeParallelizability(state.issues));
      },
      "POST /config/concurrency": async (c: any) => {
        const payload = await c.req.json() as JsonRecord;
        const value = typeof payload.concurrency === "number" ? payload.concurrency : undefined;
        if (!value || value < 1 || value > 16) {
          return c.json({ ok: false, error: "concurrency must be between 1 and 16" }, 400);
        }
        state.config.workerConcurrency = clamp(Math.round(value), 1, 16);
        state.updatedAt = now();
        addEvent(state, undefined, "manual", `Worker concurrency updated to ${state.config.workerConcurrency}.`);
        await persistState(state);
        return c.json({ ok: true, workerConcurrency: state.config.workerConcurrency });
      },
      "POST /refresh": async (c: any) => {
        addEvent(state, undefined, "manual", "Manual refresh requested via API.");
        await persistState(state);
        return c.json({ queued: true, requestedAt: now() }, 202);
      },
      "GET /events/feed": async (c: any) => {
        const since = c.req.query("since");
        const issueId = c.req.query("issueId");
        const kind = c.req.query("kind");
        const events = await listEvents({
          since: typeof since === "string" ? since : undefined,
          issueId: typeof issueId === "string" && issueId ? issueId : undefined,
          kind: typeof kind === "string" && kind ? kind : undefined,
        });
        return c.json({ events: events.slice(0, 200) });
      },
    },
  });

  const plugin = await stateDb.usePlugin(apiPlugin, "api") as { stop?: () => Promise<void> };
  setActiveApiPlugin(plugin);

  // Start WebSocket server on port+1 for realtime dashboard updates
  const WebSocketPlugin = s3dbModule.WebSocketPlugin;
  if (WebSocketPlugin) {
    try {
      const wsPlugin = new WebSocketPlugin({
        port: websocketPort,
        host: "0.0.0.0",
        health: { enabled: false },
        startupBanner: false,
      }) as { stop?: () => Promise<void>; broadcast?: (msg: unknown) => void };
      await stateDb.usePlugin(wsPlugin, "websocket");
      setWebSocketBroadcastPlugin(wsPlugin as BroadcastPlugin);
      logger.info(`WebSocket available at ws://localhost:${websocketPort}`);
    } catch (error) {
      logger.warn(`WebSocket plugin failed: ${String(error)}`);
    }
  } else {
    logger.warn("WebSocket plugin not available in this s3db version.");
  }

  logger.info(`Local dashboard available at http://localhost:${port}`);
  logger.info(`State API: http://localhost:${port}/state`);
  logger.info(`OpenAPI docs available at http://localhost:${port}/docs`);
}
