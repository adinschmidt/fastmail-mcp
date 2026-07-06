#!/usr/bin/env bun
// Mail-only entry point: exposes just the JMAP tools.
process.env.MCP_DOMAINS = process.env.MCP_DOMAINS || 'mail';
await import('../index.js');
