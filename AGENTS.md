# Agent Instructions

This repo is a Bun + TypeScript MCP server for Fastmail mail (JMAP) + calendar (CalDAV) + contacts (CardDAV).

Key paths:

- `src/index.ts` MCP server + tool registration
- `src/jmap/*` JMAP auth/client/types
- `src/dav/*` CalDAV/CardDAV client helpers + iCal/vCard helpers

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Commands (Build / Lint / Test)

Package manager/runtime:

- Install deps: `bun install` (lockfile: `bun.lock`)
- Run dev server (watch): `bun run dev`
- Run server (stdio): `bun run start`

Typecheck/build:

- Typecheck: `bun run typecheck`
- Build bundle to `dist/`: `bun run build`
- Clean build output: `bun run clean`

Lint/format:

- No linter/formatter is currently configured (no ESLint/Prettier config in repo).
- Use `bun run typecheck` as the primary quality gate.
- If adding a formatter, prefer a repo-pinned tool (devDependency + config) rather than ad-hoc `bunx`.

Tests:

- No test runner is currently configured and there are no tests in-repo.
- If/when tests are added, Bun's built-in runner is the intended default:
  - Run all: `bun test`
  - Run one file: `bun test src/foo.test.ts`
  - Run one test by name: `bun test -t "parses vCard"`
  - Watch: `bun test --watch`

## Code Style (TypeScript / Imports / Formatting)

Module system:

- ESM + `moduleResolution: NodeNext` (see `tsconfig.json`).
- Local imports MUST use `.js` extensions in source (TypeScript will map them):
  - Good: `import { loadDavConfig } from './config.js'`
  - Bad: `import { loadDavConfig } from './config'`

Imports:

- Prefer `node:` protocol for Node built-ins: `import { randomUUID } from 'node:crypto'`.
- Import order (keep blocks visually separated):
  1) Node built-ins (`node:*`)
  2) Third-party deps (`zod`, `tsdav`, MCP SDK)
  3) Local modules (`./foo.js`, `../bar.js`)

Formatting (match existing code):

- 2-space indentation
- Semicolons
- Single quotes
- Trailing commas in multiline objects/arrays when it improves diffs

Types:

- `strict: true` is on; keep it that way.
- Prefer `unknown` over `any` at boundaries; narrow/validate before use.
- `any` is acceptable only when dealing with untyped library responses (e.g. DAV/JMAP payloads), and should be kept local.
- Avoid `as any` unless there is no better typed alternative; contain it to the smallest expression.

Runtime validation:

- Use `zod` schemas for MCP tool inputs (as in `src/index.ts`).
- For data from external services (JMAP/DAV), validate or at least defensively check shapes before indexing.

Naming:

- Files/folders: lowercase (e.g. `src/jmap/client.ts`)
- Types/interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Booleans: `is*`, `has*`, `can*` (e.g. `canWrite`)
- Constants: `UPPER_SNAKE_CASE` (rare; prefer module-level `const foo = ...`)
- MCP tool names: `snake_case` (keep existing naming)

Project structure:

- Keep MCP tool wiring/IO glue in `src/index.ts`.
- Keep protocol logic in `src/jmap/*` and `src/dav/*`.
- Prefer small, testable helpers (e.g. iCal/vCard builders/parsers).

MCP tool conventions:

- Tool inputs: define a `zod` schema with `.describe(...)` strings that read well in clients.
- Tool outputs: return stable, JSON-serializable objects; keep top-level keys consistent (`id`, `url`, `etag`, `summary`, etc.).
- Back-compat: if you rename a tool, keep an alias tool name when feasible (see `get_my_fastmail_calendars`).

Quality checklist (before committing changes):

- `bun run typecheck`
- `bun run build` (if you touched bundling/runtime entry points)
- Manually sanity-check `bun run start` for startup errors when changing auth/config.

## Error Handling & Logging

- For HTTP calls, always check `res.ok`; include status + short body snippet on failure.
- Throw `Error` with actionable messages (what is missing, which id/url failed, what to do next).
- Never log or include secrets (tokens, passwords) in thrown errors.
- Startup:
  - Keep noisy stack traces behind `DEBUG` (see `src/index.ts`).

## Secrets & Repo Hygiene

- Do not commit credentials.
- Do not commit `.env` (already ignored). Treat `FASTMAIL_*` as secrets.
- Do not edit `bun.lock` by hand.

## Cursor / Copilot Rules

- No Cursor rules detected (`.cursor/rules/`, `.cursorrules` not present).
- No Copilot rules detected (`.github/copilot-instructions.md` not present).
- If any are added later, they take precedence over this file.

## Beads (bd) Quick Reference

```bash
bd ready
bd show <id>
bd update <id> --status in_progress
bd close <id>
bd sync
```

## Landing the Plane (Session Completion)

When ending a work session, work is NOT complete until `git push` succeeds.

```bash
git status
git add -A
bd sync
git commit -m "..."
bd sync
git pull --rebase
git push
git status  # must show "up to date with origin"
```

If `git push` fails, resolve and retry until it succeeds.
