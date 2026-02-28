# fastmail-mcp

Unified Model Context Protocol (MCP) server for:

- Mail via Fastmail JMAP
- Calendar via CalDAV (Fastmail)
- Contacts via CardDAV (Fastmail)

This repo is designed to work with a Fastmail **app password** for CalDAV/CardDAV and can optionally use a Fastmail JMAP API token for mail.

## Requirements

- Bun 1.3+ (recommended)
- Node.js 18+ (optional)
- Fastmail account
- Fastmail app password (recommended)

## Configuration

For full access (mail + calendar + contacts), set:

- `FASTMAIL_API_TOKEN`
- `FASTMAIL_USERNAME`
- `FASTMAIL_APP_PASSWORD`

### Auth (recommended)

Set:

- `FASTMAIL_USERNAME` (your Fastmail login / email)
- `FASTMAIL_APP_PASSWORD` (Fastmail app password)

Optional:

- `FASTMAIL_BASE_URL` (default: `https://api.fastmail.com`)
- `FASTMAIL_CALDAV_URL` (default: `https://caldav.fastmail.com`)
- `FASTMAIL_CARDDAV_URL` (default: `https://carddav.fastmail.com`)
- `FASTMAIL_DAV_USERNAME` (if your DAV username differs from `FASTMAIL_USERNAME`)
- `FASTMAIL_ORGANIZER_EMAIL` (override ORGANIZER email used when generating events)

### Auth (optional alternative)

If you prefer using a Fastmail API token for mail/JMAP:

- `FASTMAIL_API_TOKEN`

## Install

```bash
bun install
```

Optional (build a single-file `dist/` bundle):

```bash
bun run build
```

## Run

```bash
bun run start
```

Dev (auto-reload):

```bash
bun run dev
```

Run via bunx:

```bash
bunx --bun github:adinschmidt/fastmail-mcp
```

## MCP Client Config Examples

### Generic MCP config (`mcpServers`)

```jsonc
{
  "mcpServers": {
    "fastmail": {
      "command": "bun",
      "args": ["/absolute/path/to/fastmail-mcp/src/index.ts"],
      "env": {
        "FASTMAIL_USERNAME": "you@fastmail.com",
        "FASTMAIL_APP_PASSWORD": "your-app-password"
      }
    }
  }
}
```

If you prefer `bunx`:

```jsonc
{
  "mcpServers": {
    "fastmail": {
      "command": "bunx",
      "args": ["--bun", "github:adinschmidt/fastmail-mcp"],
      "env": {
        "FASTMAIL_USERNAME": "you@fastmail.com",
        "FASTMAIL_APP_PASSWORD": "your-app-password",
        "FASTMAIL_API_TOKEN": "your-fastmail-api-token"
      }
    }
  }
}
```

### OpenCode config (`.mcp.json`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "fastmail": {
      "type": "local",
      "command": ["bun", "./src/index.ts"],
      "enabled": true,
      "environment": {
        "FASTMAIL_USERNAME": "you@fastmail.com",
        "FASTMAIL_APP_PASSWORD": "your-app-password"
      }
    }
  }
}
```

## Tools

Mail (JMAP):

- `list_mailboxes`
- `create_mailbox`
- `update_mailbox`
- `delete_mailbox`
- `list_emails`
- `get_email`
- `search_emails`
- `send_email`
- `mark_email_read`
- `move_email`
- `delete_email`

Calendar (CalDAV):

- `list_calendars`
- `get_calendar_event`
- `list_calendar_events`
- `create_calendar_event`
- `update_calendar_event`
- `delete_calendar_event`

Contacts (CardDAV):

- `list_contact_lists`
- `list_contacts`
- `get_contact`
- `create_contact`
- `search_contacts`
- `update_contact`
- `delete_contact`

## Security Notes

- Prefer app passwords (Fastmail Settings > Privacy & Security > App passwords).
- `delete_mailbox` refuses to delete protected system mailboxes (for example Inbox, Spam, Trash, Sent, Drafts, Archive).

## Troubleshooting

### 403 Forbidden creating calendar events

In almost all cases this means you're trying to write to a **read-only** calendar (e.g. a subscribed/shared calendar).

1. Run `list_calendars`
2. Pick a calendar with `canWrite: true`
3. Use that calendar's `id` as `calendarId` for `create_calendar_event`
