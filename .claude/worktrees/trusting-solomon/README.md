# mcps

A collection of MCP (Model Context Protocol) servers.

| Package | Description |
|---------|-------------|
| [fastmail-mcp](packages/fastmail-mcp/) | Mail (JMAP), calendar (CalDAV), and contacts (CardDAV) for Fastmail |
| [splitwise-mcp](packages/splitwise-mcp/) | All 27 endpoints from the Splitwise API |

## Setup

```bash
bun install        # installs all packages via workspaces
```

## Running a server

```bash
bun run --filter fastmail-mcp start
bun run --filter splitwise-mcp start
```

Or directly:

```bash
bun packages/fastmail-mcp/src/index.ts
bun packages/splitwise-mcp/src/index.ts
```

## Structure

```
packages/
├── fastmail-mcp/      # see its README for auth & config
└── splitwise-mcp/     # see its README for auth & config
```

Each package is independent — its own `package.json`, `tsconfig.json`, and entry point. See the individual READMEs for authentication setup, environment variables, and available tools.

## License

MIT
