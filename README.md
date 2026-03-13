# Symphifo

Symphifo is a filesystem-backed local orchestrator with a TypeScript runtime, `codex` and `claude` agent support, and durable state stored under the current workspace by default.

## Features

- Pure TypeScript runtime with no external tracker dependency.
- Automatic provider detection (`claude`, `codex`) with sensible defaults.
- Structured logging via `pino` with file + console output.
- Skill hydration — agent profiles and discovered skills injected into prompts.
- Parallelism intelligence — analyzes path overlap and dependencies to recommend safe concurrency.
- Graceful shutdown — persists state on SIGINT/SIGTERM before exiting.
- Persists runtime, issues, sessions, and pipelines through `s3db.js`.
- Serves the HTTP API through the `s3db.js` `ApiPlugin`.
- Supports mixed multi-agent workflows with `codex` and `claude`.

## CLI

Install dependencies and run from the package root:

```bash
pnpm install --ignore-workspace
```

Runtime requirement:

- Node.js 23 or newer

Run the standard local runtime:

```bash
npx -y symphifo
```

Run the MCP server over stdio:

```bash
npx -y symphifo mcp
```

Start the API and dashboard:

```bash
npx -y symphifo --port 4040
```

Override the persistence root:

```bash
npx -y symphifo --persistence /path/to/root
```

By default:

- the current directory is the workspace root
- state is stored under `./.symphifo/`
- the runtime can start with zero seed issues

When `--port` is set, open:

- `http://localhost:4040`
- `http://localhost:4040/docs`

## Use the app

Run the local UI:

```bash
npx -y symphifo --port 4040
```

Default local flow:

1. Open `http://localhost:4040`
2. Create an issue from the UI or `POST /api/issues`
3. Add `labels` and `paths` when you want stronger automatic routing
4. Watch the queue, capability category, overlays, events, and agent sessions
5. Use `View Sessions` on an issue to inspect the current pipeline, turns, directives, and latest output

Minimal issue payload:

```json
{
  "title": "Build release workflow",
  "description": "Prepare the first stable npm release",
  "labels": ["devops", "release"],
  "paths": [".github/workflows/ci.yml", "package.json"]
}
```

Useful app routes:

- `/` — dashboard
- `/docs` — OpenAPI docs from `ApiPlugin`
- `/api/state` — runtime snapshot with capability counts
- `/api/issues` — issue CRUD
- `/api/events` — filtered event feed
- `/api/issue/:id/pipeline` — pipeline snapshot for one issue
- `/api/issue/:id/sessions` — session history for one issue

Useful API examples:

```bash
curl -X POST http://localhost:4040/api/issues \
  -H 'content-type: application/json' \
  -d '{
    "title":"Prepare release notes",
    "labels":["documentation","release"],
    "paths":["README.md","RELEASE.md"]
  }'
```

```bash
curl 'http://localhost:4040/api/issues?state=Todo&capabilityCategory=devops'
```

## Package layout

- `bin/symphifo.js` — published CLI entrypoint
- `src/cli.ts` — command router built on `cli-args-parser`
- `src/mcp/server.ts` — stdio MCP server
- `src/runtime/run-local.ts` — thin main entrypoint
- `src/runtime/types.ts` — shared type definitions
- `src/runtime/logger.ts` — pino-based structured logging
- `src/runtime/constants.ts` — paths, env vars, state constants
- `src/runtime/helpers.ts` — pure utility functions
- `src/runtime/store.ts` — s3db state persistence
- `src/runtime/providers.ts` — provider detection, profile resolution, capability routing
- `src/runtime/workflow.ts` — WORKFLOW.md loading and source bootstrapping
- `src/runtime/issues.ts` — issue CRUD, config, metrics, events
- `src/runtime/agent.ts` — agent session/pipeline execution
- `src/runtime/scheduler.ts` — issue scheduling, parallelism analysis, graceful shutdown
- `src/runtime/api-server.ts` — HTTP API and dashboard serving
- `src/runtime/skills.ts` — skill discovery and hydration
- `src/routing/capability-resolver.ts` — task classification engine
- `src/integrations/catalog.ts` — agent/skill integration discovery
- `src/dashboard/{index.html,app.js,styles.css}` — web UI
- `src/fixtures/local-issues.json` — optional seed issue catalog

## Workflow contract

If the target workspace contains `WORKFLOW.md`, Symphifo reads its YAML front matter and Markdown body.

Supported fields:

- `tracker.kind`
- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `poll.interval_ms`
- `agent.provider`
- `agent.providers[]`
- `agent.profile`
- `agent.max_concurrent_agents`
- `agent.max_attempts`
- `agent.max_turns`
- `codex.command`
- `claude.command`
- `codex.timeout_ms`
- `server.port`
- `routing.enabled`
- `routing.priorities`
- `routing.overrides[]`
- `routing.overrides[].match.paths`

The Markdown body is rendered as the issue prompt and exported through:

- `SYMPHIFO_PROMPT`
- `SYMPHIFO_PROMPT_FILE`

If no command is configured, Symphifo auto-detects available providers (`claude`, `codex`) and uses sensible defaults.

## Agent runtime contract

Each agent turn receives:

- `SYMPHIFO_AGENT_PROVIDER`
- `SYMPHIFO_AGENT_ROLE`
- `SYMPHIFO_AGENT_PROFILE`
- `SYMPHIFO_AGENT_PROFILE_FILE`
- `SYMPHIFO_AGENT_PROFILE_INSTRUCTIONS`
- `SYMPHIFO_SESSION_ID`
- `SYMPHIFO_SESSION_KEY`
- `SYMPHIFO_TURN_INDEX`
- `SYMPHIFO_MAX_TURNS`
- `SYMPHIFO_TURN_PROMPT`
- `SYMPHIFO_TURN_PROMPT_FILE`
- `SYMPHIFO_PREVIOUS_OUTPUT`
- `SYMPHIFO_RESULT_FILE`

The agent can advance the session by:

- printing `SYMPHIFO_STATUS=continue|done|blocked|failed`
- writing `symphifo-result.json` with `status`, `summary`, and optional `nextPrompt`

Session and pipeline state are persisted in the local `s3db` store.
Workspace JSON files are temporary CLI handoff artifacts only.

Agent profiles can be resolved from:

- `./.codex/agents/<name>.md`
- `./agents/<name>.md`
- `~/.codex/agents/<name>.md`
- `~/.claude/agents/<name>.md`

Command resolution order:

1. `SYMPHIFO_AGENT_COMMAND`
2. provider-specific workflow command: `codex.command` or `claude.command`
3. provider binary name: `codex` or `claude`

Example mixed pipeline:

```yaml
agent:
  max_turns: 4
  providers:
    - provider: claude
      role: planner
    - provider: codex
      role: executor
    - provider: claude
      role: reviewer
```

Example routing override:

```yaml
routing:
  priorities:
    security: 0
    bugfix: 1
    backend: 2
  overrides:
    - match:
        labels: ["frontend", "marketing"]
        paths: ["src/web", "src/dashboard"]
      overlays: ["impeccable", "frontend-design"]
      providers:
        - provider: claude
          role: planner
          profile: agency-ui-designer
          reason: Marketing frontend needs stronger design planning.
        - provider: codex
          role: executor
          profile: agency-frontend-developer
          reason: Frontend implementation.
        - provider: claude
          role: reviewer
          profile: agency-accessibility-auditor
          reason: Review with stronger UX and accessibility standards.
```

Issue payloads can include `paths` so the resolver can classify by target files and directories, not only title and labels:

```json
{
  "title": "Harden websocket reconnect flow",
  "labels": ["backend", "protocol"],
  "paths": ["src/protocol/session.ts", "src/api/ws-handler.ts"]
}
```

If `paths` is omitted, Symphifo still tries to infer routing signals from:

- path-like mentions in the title and description
- changed files already present in the persisted issue workspace

Symphifo also derives queue labels such as `capability:<category>` and `overlay:<name>` from the resolver output.
The scheduler uses capability priority as a tie-breaker after issue priority, and `routing.priorities` can override the default category order.

## Durable local state

- `./.symphifo/WORKFLOW.local.md`
- `./.symphifo/s3db/`
- `./.symphifo/symphifo-local.log`

## HTTP surface

Endpoints:

- `GET /api/issues?state=Todo&capabilityCategory=backend`
- `POST /api/issues`
- `PUT /api/issues/:id` — edit issue (title, description, priority, labels, paths, blockedBy)
- `DELETE /api/issues/:id` — delete issue
- `GET /api/events?issueId=LOCAL-1&kind=runner&since=2026-03-13T00:00:00.000Z`
- `GET /api/issue/:id/pipeline`
- `GET /api/issue/:id/sessions`
- `POST /api/issue/:id/state`
- `POST /api/issue/:id/retry`
- `POST /api/issue/:id/cancel`
- `GET /api/providers` — detected providers with availability status
- `GET /api/parallelism` — parallelizability analysis for current issues
- `POST /api/config/concurrency` — update worker concurrency at runtime

The built-in dashboard now filters issues by both runtime state and capability category, and mirrors the scheduler's capability-aware ordering.
`GET /api/state` and the MCP status summary also expose aggregated capability counts.
The live events panel also filters by `kind` and `issueId`, backed by the partitioned `/api/events` route.

Native `ApiPlugin` resources:

- `symphifo_runtime_state`
- `symphifo_issues`
- `symphifo_events`
- `symphifo_agent_sessions`
- `symphifo_agent_pipelines`

These resources also define `s3db` partitions for the main operational access patterns:

- issues: `byState`, `byCapabilityCategory`, `byStateAndCapability`
- events: `byIssueId`, `byKind`, `byIssueIdAndKind`
- sessions: `byIssueId`, `byIssueAttempt`, `byProviderRole`
- pipelines: `byIssueId`, `byIssueAttempt`

The issue inspection routes use these partitions directly, including pipeline/session lookups by `issueId + attempt`.

## MCP surface

`npx -y symphifo mcp` starts a stdio MCP server backed by the same `s3db` filesystem store as the runtime.

Resources:

- `symphifo://guide/overview`
- `symphifo://guide/runtime`
- `symphifo://guide/integration`
- `symphifo://state/summary`
- `symphifo://issues`
- `symphifo://workspace/workflow`
- `symphifo://issue/<id>`

Tools:

- `symphifo.status`
- `symphifo.list_issues` with optional `state`, `capabilityCategory`, or `category`
- `symphifo.create_issue`
- `symphifo.update_issue_state`
- `symphifo.integration_config`
- `symphifo.resolve_capabilities`

Prompts:

- `symphifo-integrate-client`
- `symphifo-plan-issue`
- `symphifo-review-workflow`

Minimal MCP client configuration:

```json
{
  "mcpServers": {
    "symphifo": {
      "command": "npx",
      "args": ["-y", "symphifo", "mcp", "--workspace", "/path/to/workspace", "--persistence", "/path/to/workspace"]
    }
  }
}
```

## GitHub Actions release flow

- `pull_request`: runs the quality gate
- `push` to `main`: runs quality and publishes `symphifo@next`
- tag `v*`: runs quality, publishes stable, and creates a GitHub Release

Required repository secret:

- `NPM_TOKEN` for `pnpm publish`

## Ship v1 yourself

1. Confirm `NPM_TOKEN` is configured in GitHub Actions
2. Make sure `package.json` has the version you want to release
3. Push `main`
4. Wait for the `@next` publish to pass
5. Create and push the stable tag

Commands:

```bash
git push origin main
git tag v0.1.0
git push origin v0.1.0
```

After publish:

```bash
npx -y symphifo@latest --port 4040
npx -y symphifo@latest mcp
```

Release checklist:

- [RELEASE.md](./RELEASE.md)
