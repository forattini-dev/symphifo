# Symphifo

Symphifo is a filesystem-backed local orchestrator with a TypeScript runtime, `codex` and `claude` agent support, and durable state stored under the current workspace by default.

## What this fork changes

- Removes the Linear dependency from the local execution path.
- Replaces the local Elixir bootstrap with a TypeScript CLI.
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
npx symphifo
```

Run the MCP server over stdio:

```bash
npx symphifo mcp
```

Start the API and dashboard:

```bash
npx symphifo --port 4040
```

Override the persistence root:

```bash
npx symphifo --persistence /path/to/root
```

By default:

- the current directory is the workspace root
- state is stored under `./.symphifo/`
- the runtime can start with zero seed issues

When `--port` is set, open:

- `http://localhost:4040`
- `http://localhost:4040/docs`

## Package layout

- `bin/symphifo.js` — published CLI entrypoint
- `src/cli.ts` — command router built on `cli-args-parser`
- `src/mcp/server.ts` — stdio MCP server
- `src/runtime/run-local.ts` — local runtime
- `src/dashboard/index.html`
- `src/dashboard/app.js`
- `src/dashboard/styles.css`
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

The Markdown body is rendered as the issue prompt and exported through:

- `SYMPHIFO_PROMPT`
- `SYMPHIFO_PROMPT_FILE`

`codex.command` or `SYMPHIFO_AGENT_COMMAND` is required. There is no simulator fallback.

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

## Durable local state

- `./.symphifo/WORKFLOW.local.md`
- `./.symphifo/s3db/`
- `./.symphifo/symphifo-local.log`

## HTTP surface

Compatibility endpoints:

- `GET /api/issues`
- `POST /api/issues`
- `GET /api/issue/:id/pipeline`
- `GET /api/issue/:id/sessions`
- `POST /api/issue/:id/state`
- `POST /api/issue/:id/retry`
- `POST /api/issue/:id/cancel`

Native `ApiPlugin` resources:

- `symphifo_runtime_state`
- `symphifo_issues`
- `symphifo_events`
- `symphifo_agent_sessions`
- `symphifo_agent_pipelines`

## MCP surface

`npx symphifo mcp` starts a stdio MCP server backed by the same `s3db` filesystem store as the runtime.

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
- `symphifo.list_issues`
- `symphifo.create_issue`
- `symphifo.update_issue_state`
- `symphifo.integration_config`

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
      "args": ["symphifo", "mcp", "--workspace", "/path/to/workspace", "--persistence", "/path/to/workspace"]
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

Release checklist:

- [RELEASE.md](./RELEASE.md)
