Check out my [other MCP tools](https://github.com/adinschmidt/mcps)

# jmap-dav-mcp

Generic Model Context Protocol (MCP) server for open email/PIM standards:

- Mail via **JMAP** (RFC 8620/8621)
- Calendar via **CalDAV**
- Contacts via **CardDAV**

Works with any compliant server. **Fastmail works out of the box** (this project began as `fastmail-mcp`), and the JMAP side also works with self-hosted servers like Stalwart, Cyrus, and Apache James. The CalDAV/CardDAV side works with iCloud, Nextcloud, Radicale, Baïkal, and friends.

Tool domains (mail / calendar / contacts) are registered based on which credentials you configure — a calendar-only setup exposes only calendar tools.

## Requirements

- Bun 1.3+ (recommended) or Node.js 18+
- Credentials for a JMAP and/or CalDAV/CardDAV server

## Configuration

### Mail (JMAP)

| Variable | Description |
| --- | --- |
| `JMAP_BASE_URL` | Server base URL. The session is discovered at `<base>/.well-known/jmap` (RFC 8620). |
| `JMAP_SESSION_URL` | Alternative: point directly at the session resource (overrides `JMAP_BASE_URL`). |
| `JMAP_API_TOKEN` | Bearer token auth (recommended where supported). |
| `JMAP_USERNAME` + `JMAP_PASSWORD` | Basic auth alternative. |

### Calendar + Contacts (CalDAV/CardDAV)

| Variable | Description |
| --- | --- |
| `CALDAV_URL` | CalDAV server URL (server root is fine — collections are discovered). |
| `CARDDAV_URL` | CardDAV server URL. |
| `DAV_USERNAME` + `DAV_PASSWORD` | Basic auth credentials (use an app password where supported). |
| `DAV_ORGANIZER_EMAIL` | Optional. ORGANIZER email used when generating events (defaults to `DAV_USERNAME`). |

### Domain selection

| Variable | Description |
| --- | --- |
| `MCP_DOMAINS` | Optional comma list of `mail`, `calendar`, `contacts`. Overrides credential-based auto-detection. |

### Fastmail

Legacy `FASTMAIL_*` variables are fully supported and imply the Fastmail server URLs, so an existing Fastmail setup needs no URL configuration:

- `FASTMAIL_USERNAME` + `FASTMAIL_APP_PASSWORD` — mail (JMAP basic auth) + calendar + contacts
- `FASTMAIL_API_TOKEN` — mail via JMAP bearer token (optional alternative)
- `FASTMAIL_BASE_URL`, `FASTMAIL_CALDAV_URL`, `FASTMAIL_CARDDAV_URL`, `FASTMAIL_DAV_USERNAME`, `FASTMAIL_ORGANIZER_EMAIL` — optional overrides

Create an app password in Fastmail Settings → Privacy & Security → App passwords.

## Install

```bash
bun install
```

Optional (bundle to `dist/`):

```bash
bun run build
```

## Run

```bash
bun run start        # all configured domains
```

Dev (auto-reload):

```bash
bun run dev
```

Via bunx:

```bash
bunx --bun github:adinschmidt/fastmail-mcp
```

### Entry points

| Bin | Domains |
| --- | --- |
| `jmap-dav-mcp` (also `fastmail-mcp`) | everything configured |
| `jmap-mcp` (`src/bin/jmap-mcp.ts`) | mail only |
| `dav-mcp` (`src/bin/dav-mcp.ts`) | calendar + contacts only |

## MCP Client Config Examples

### Fastmail (`mcpServers`)

```jsonc
{
  "mcpServers": {
    "fastmail": {
      "command": "bun",
      "args": ["/absolute/path/to/jmap-dav-mcp/src/index.ts"],
      "env": {
        "FASTMAIL_USERNAME": "you@fastmail.com",
        "FASTMAIL_APP_PASSWORD": "your-app-password"
      }
    }
  }
}
```

### Generic servers

```jsonc
{
  "mcpServers": {
    "mail-calendar-contacts": {
      "command": "bun",
      "args": ["/absolute/path/to/jmap-dav-mcp/src/index.ts"],
      "env": {
        "JMAP_BASE_URL": "https://mail.example.com",
        "JMAP_API_TOKEN": "your-token",
        "CALDAV_URL": "https://dav.example.com",
        "CARDDAV_URL": "https://dav.example.com",
        "DAV_USERNAME": "you@example.com",
        "DAV_PASSWORD": "your-app-password"
      }
    }
  }
}
```

### Calendar/contacts only (e.g. iCloud, Nextcloud)

```jsonc
{
  "mcpServers": {
    "calendar": {
      "command": "bun",
      "args": ["/absolute/path/to/jmap-dav-mcp/src/bin/dav-mcp.ts"],
      "env": {
        "CALDAV_URL": "https://caldav.icloud.com",
        "CARDDAV_URL": "https://contacts.icloud.com",
        "DAV_USERNAME": "you@icloud.com",
        "DAV_PASSWORD": "app-specific-password"
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
- `get_email_attachments`
- `download_attachment`

Calendar (CalDAV):

- `list_calendars`
- `create_calendar`
- `update_calendar`
- `delete_calendar`
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

- Prefer app passwords / API tokens over your account password.
- `delete_mailbox` refuses to delete protected system mailboxes (Inbox, Spam, Trash, Sent, Drafts, Archive).
- `delete_calendar` refuses to delete the last remaining calendar.

## Troubleshooting

### 403 Forbidden creating calendar events

In almost all cases this means you're trying to write to a **read-only** calendar (e.g. a subscribed/shared calendar).

1. Run `list_calendars`
2. Pick a calendar with `canWrite: true`
3. Use that calendar's `id` as `calendarId` for `create_calendar_event`

### JMAP session errors on non-Fastmail servers

The session is discovered at `<JMAP_BASE_URL>/.well-known/jmap`, following redirects with auth. If your server hosts the session elsewhere, set `JMAP_SESSION_URL` directly.
