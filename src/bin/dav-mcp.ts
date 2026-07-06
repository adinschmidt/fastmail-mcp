#!/usr/bin/env bun
// Calendar/contacts-only entry point: exposes just the CalDAV/CardDAV tools.
process.env.MCP_DOMAINS = process.env.MCP_DOMAINS || 'calendar,contacts';
await import('../index.js');
