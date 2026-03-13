# Symphifo release playbook

This repository publishes through GitHub Actions.

## Prerequisites

- GitHub Actions is enabled for the repository.
- Repository secret `NPM_TOKEN` is configured.
- The package name `symphifo` is available on npm, or the npm organization is already configured.
- `main` is the branch used for release automation.
- Node.js 23+ is the runtime target for the published package.

## Release channels

- `main` push: publishes `symphifo@next`
- tag `v*`: publishes `symphifo@latest` and creates a GitHub Release

## First release checklist

1. Confirm the package version in `package.json`.
2. Push the current branch to `main`.
3. Wait for the `Symphifo CI/CD` workflow to pass.
4. Confirm that `symphifo@next` was published successfully.
5. Create a stable tag matching `package.json`.
6. Push the tag.
7. Wait for the stable workflow to publish `latest` and create the GitHub Release.

## Commands

Publish `next` from `main`:

```bash
git push origin main
```

Create the first stable release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Replace `0.1.0` with the exact version from `package.json`.

## Pre-flight checks

Run locally before pushing:

```bash
pnpm install --ignore-workspace
node ./bin/symphifo.js --once
node ./bin/symphifo.js mcp
```

Expected outcomes:

- `symphifo --once` exits with a clear configuration error if no agent command is set
- `symphifo mcp` starts and responds to MCP `initialize`

## Recommended first rollout

1. Publish `next` first.
2. Install from npm in a clean directory:

```bash
npx symphifo@next --once
npx symphifo@next mcp
```

3. If that looks correct, publish the stable tag.

## Rollback

If `next` is bad:

- publish a fixed commit to `main`
- let the workflow publish a new `@next`

If `latest` is bad:

- fix forward with a new patch version
- tag the new version and publish again

Do not reuse or overwrite an existing npm version.
