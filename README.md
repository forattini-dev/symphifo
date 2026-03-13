# Symphony (symphifo)

Local Symphony fork using a **TypeScript-only (Codex-only)** runtime.

## What changed in this fork

- Removed the local Linear workflow.
- Removed Elixir dependency from the local bootstrap.
- Local runtime uses in-memory (`memory`) tracking only.
- Local dashboard at `scripts/symphony-dashboard`.
- Execution wrapper at `scripts/start-symphony.sh`.

## Local run

```bash
./scripts/start-symphony.sh --port 4040
```

Open:

- `http://localhost:4040`

Without the dashboard:

```bash
./scripts/start-symphony.sh
```

## Main files

- `scripts/run-symphony-local.ts` — local TS runtime.
- `scripts/start-symphony.sh` — entrypoint.
- `scripts/symphony-dashboard/index.html`
- `scripts/symphony-dashboard/app.js`
- `scripts/symphony-dashboard/styles.css`
- `scripts/symphony-local-issues.json` — local issue catalog.

## Local state

- `~/.local/share/symphony-aozo/WORKFLOW.local.md`
- `~/.local/share/symphony-aozo/symphony-memory-state.json`
