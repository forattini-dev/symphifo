# Symphifo local runtime reference

This repository runs Symphifo as a local TypeScript package with no Linear dependency and no Elixir runtime.

## What this package provides

- Filesystem-backed orchestration through the local persistence runtime.
- Optional seed issues from `src/fixtures/local-issues.json`.
- Durable tracker state that can also start empty and accept work over HTTP.
- Local workspace snapshots for reproducible execution.
- Queue runner with concurrency, retries, retry backoff, and stale-run recovery.
- Local event log, API, and dashboard through the `s3db.js` `ApiPlugin`.
- Multi-agent pipelines with `codex` and `claude`.

## Relevant files

- Workflow template: [WORKFLOW.md](./WORKFLOW.md)
- Published entrypoint: [bin/symphifo.js](./bin/symphifo.js)
- CLI router: [src/cli.ts](./src/cli.ts)
- Runtime engine: [src/runtime/run-local.ts](./src/runtime/run-local.ts)
- Dashboard: [src/dashboard/index.html](./src/dashboard/index.html)

## Environment variables

```bash
export SYMPHIFO_TRACKER_KIND=filesystem
export SYMPHIFO_WORKSPACE_ROOT=$PWD
export SYMPHIFO_PERSISTENCE=$PWD
export SYMPHIFO_ISSUES_FILE=/path/to/issues.json
export SYMPHIFO_ISSUES_JSON='[{"id":"LOCAL-1","title":"...","description":"...","state":"Todo"}]'
export SYMPHIFO_AGENT_COMMAND='codex run --json "$SYMPHIFO_ISSUE_JSON"'
export SYMPHIFO_AGENT_PROVIDER=codex
export SYMPHIFO_WORKER_CONCURRENCY=2
export SYMPHIFO_MAX_ATTEMPTS=3
export SYMPHIFO_AGENT_MAX_TURNS=4
```

`SYMPHIFO_AGENT_COMMAND` is required unless `WORKFLOW.md` provides `codex.command` or `claude.command`.

Node requirement:

- Node.js 23 or newer

## Start examples

```bash
npx symphifo
```

Default state location:

```bash
./.symphifo/
```

Override the persistence root:

```bash
npx symphifo --persistence /path/to/root
```

Run the MCP server:

```bash
npx symphifo mcp
```

Run a single cycle:

```bash
npx symphifo --once
```

Run with the API and dashboard:

```bash
npx symphifo --port 4040 --concurrency 2 --attempts 3
```

## Runtime behavior

- Local bootstrap creates a source snapshot under `./.symphifo/source`.
- Issues are loaded from the configured JSON source when available.
- Workflow is rendered to `./.symphifo/WORKFLOW.local.md`.
- Runtime state is stored under `./.symphifo/s3db/` by the `s3db.js` `FileSystemClient`.
- Event log is stored in `./.symphifo/symphifo-local.log`.
- `WORKFLOW.md` front matter and Markdown body define the execution contract when present.
- `hooks.after_create` runs once for a new issue workspace; otherwise the runtime copies the local source snapshot.
- `hooks.before_run` and `hooks.after_run` can wrap each agent turn.
- `agent.provider` can be `codex` or `claude`.
- `agent.providers[]` can mix both in one pipeline.
- `agent.profile` resolves to local profile files from workspace or home directories.
- The rendered prompt is written to `symphifo-prompt.md` and exported through `SYMPHIFO_PROMPT` and `SYMPHIFO_PROMPT_FILE`.
- Each issue runs as a multi-turn session controlled by `agent.max_turns`.
- Each turn exports `SYMPHIFO_AGENT_PROVIDER`, `SYMPHIFO_AGENT_ROLE`, `SYMPHIFO_AGENT_PROFILE`, `SYMPHIFO_AGENT_PROFILE_FILE`, `SYMPHIFO_AGENT_PROFILE_INSTRUCTIONS`, `SYMPHIFO_SESSION_ID`, `SYMPHIFO_SESSION_KEY`, `SYMPHIFO_TURN_INDEX`, `SYMPHIFO_MAX_TURNS`, `SYMPHIFO_TURN_PROMPT`, `SYMPHIFO_TURN_PROMPT_FILE`, `SYMPHIFO_PREVIOUS_OUTPUT`, and `SYMPHIFO_RESULT_FILE`.
- The agent can continue, finish, block, or fail by printing `SYMPHIFO_STATUS=...` or by writing `symphifo-result.json`.
- Session and pipeline state are persisted in `s3db`.
- Workspace JSON artifacts are temporary CLI handoff files, not the source of truth.
- The scheduler advances one turn per execution slot and resumes persisted `In Progress` work.
- `npx symphifo mcp` keeps the scheduler alive even without the dashboard port.
- `npx symphifo mcp` starts a stdio MCP server backed by the same durable `s3db` state as the runtime.

## MCP capabilities

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

Recommended MCP client config:

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

## HTTP surface

Compatibility routes:

- `/api/state`
- `/api/issues`
- `POST /api/issues`
- `/api/issue/:id/pipeline`
- `/api/issue/:id/sessions`
- `/api/events`
- `/api/health`

Generated documentation and native resources:

- `/docs`
- `/symphifo_runtime_state`
- `/symphifo_issues`
- `/symphifo_events`
- `/symphifo_agent_sessions`
- `/symphifo_agent_pipelines`
