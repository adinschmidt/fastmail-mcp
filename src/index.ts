#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  loadDavConfig,
  loadJmapAuthConfig,
  hasJmapConfig,
  hasDavConfig,
  getOrganizerEmail,
} from './config.js';
import { JmapAuth } from './jmap/auth.js';
import { JmapClient } from './jmap/client.js';
import { createDavClients, DavClients } from './dav/client.js';
import { buildIcsEvent, parseIcsSummary } from './dav/ical.js';
import { buildVCard, parseVCardSummary } from './dav/vcard.js';
import {
  extractCalendarTimezone,
  resolveTimezone,
  isValidTimezone,
  ensureOffsetAware,
  getMachineTimezone,
  buildCalendarTimezoneProperty,
} from './dav/timezone.js';

const server = new McpServer({
  name: 'jmap-dav-mcp',
  version: '0.2.0',
  title: 'Mail, Calendar & Contacts (JMAP/DAV)',
  description:
    'Generic MCP server for mail (JMAP) + calendar (CalDAV) + contacts (CardDAV). Works with Fastmail out of the box.',
});

type ToolDomain = 'mail' | 'calendar' | 'contacts';
const ALL_DOMAINS: ToolDomain[] = ['mail', 'calendar', 'contacts'];

function resolveDomains(): Set<ToolDomain> {
  const raw = process.env.MCP_DOMAINS;
  if (raw && raw.trim()) {
    const requested = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const invalid = requested.filter((d) => !ALL_DOMAINS.includes(d as ToolDomain));
    if (invalid.length) {
      throw new Error(`Invalid MCP_DOMAINS entries: ${invalid.join(', ')}. Valid: ${ALL_DOMAINS.join(', ')}`);
    }
    return new Set(requested as ToolDomain[]);
  }
  const auto = new Set<ToolDomain>();
  if (hasJmapConfig()) auto.add('mail');
  if (hasDavConfig()) {
    auto.add('calendar');
    auto.add('contacts');
  }
  // Nothing configured yet: register everything so clients can browse the
  // tools; calls fail with actionable configuration errors.
  return auto.size ? auto : new Set(ALL_DOMAINS);
}

const domains = resolveDomains();

// Registers the tool only when its domain is enabled. Cast preserves the
// generic signature of server.registerTool so handler params stay inferred.
function makeTool(enabled: boolean): McpServer['registerTool'] {
  if (enabled) return server.registerTool.bind(server) as McpServer['registerTool'];
  return ((..._args: unknown[]) => undefined) as unknown as McpServer['registerTool'];
}
const mailTool = makeTool(domains.has('mail'));
const calendarTool = makeTool(domains.has('calendar'));
const contactTool = makeTool(domains.has('contacts'));

let jmapClient: JmapClient | null = null;
let davClients: DavClients | null = null;

function getJmapClient(): JmapClient {
  if (jmapClient) return jmapClient;
  const cfg = loadJmapAuthConfig();
  const auth = new JmapAuth(cfg);
  jmapClient = new JmapClient(auth);
  return jmapClient;
}

function getDavClients(): DavClients {
  if (davClients) return davClients;
  const cfg = loadDavConfig();
  davClients = createDavClients(cfg);
  return davClients;
}

function asText(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

type DavRights = {
  privileges: string[];
  canRead: boolean;
  canWrite: boolean;
};

function extractDavPrivileges(currentUserPrivilegeSet: any): string[] {
  const privilege = currentUserPrivilegeSet?.privilege;
  const items = Array.isArray(privilege) ? privilege : privilege ? [privilege] : [];
  const out: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const k of Object.keys(item)) {
      if (k === '_attributes') continue;
      out.push(k);
    }
  }
  return Array.from(new Set(out));
}

function computeDavRights(privileges: string[]): DavRights {
  const canRead = privileges.includes('read') || privileges.includes('all');
  const canWrite =
    privileges.includes('write') ||
    privileges.includes('writeContent') ||
    privileges.includes('writeProperties') ||
    privileges.includes('all');
  return { privileges, canRead, canWrite };
}

async function getCalendarRights(caldav: DavClients['caldav'], calendarUrl: string): Promise<DavRights | null> {
  try {
    const res = await caldav.propfind({
      url: calendarUrl,
      depth: '0',
      props: {
        'current-user-privilege-set': {},
      } as any,
    });

    const props = res?.[0]?.props as any;
    const privileges = extractDavPrivileges(props?.currentUserPrivilegeSet);
    if (!privileges.length) return null;
    return computeDavRights(privileges);
  } catch {
    return null;
  }
}

async function listCalendarsWithRights(): Promise<any[]> {
  const { caldav } = getDavClients();
  await caldav.login();
  const calendars = await caldav.fetchCalendars();

  return await Promise.all(
    (calendars || []).map(async (c: any) => {
      const rights = await getCalendarRights(caldav, c.url);
      return {
        id: c.url,
        name: typeof c.displayName === 'string' ? c.displayName : String(c.displayName ?? ''),
        url: c.url,
        timezone: extractCalendarTimezone(c.timezone),
        canWrite: rights?.canWrite,
        privileges: rights?.privileges,
      };
    })
  );
}

const PROTECTED_MAILBOX_ROLES = new Set([
  'inbox',
  'spam',
  'trash',
  'sent',
  'drafts',
  'archive',
  'junk',
]);

const PROTECTED_MAILBOX_NAMES = new Set([
  'inbox',
  'spam',
  'junk',
  'trash',
  'sent',
  'drafts',
  'archive',
]);

function assertMailboxCanBeDeleted(mailboxes: any[], mailboxId: string): void {
  const mailbox = (mailboxes || []).find((m: any) => m?.id === mailboxId);
  if (!mailbox) {
    throw new Error(`Mailbox not found: ${mailboxId}`);
  }

  const role = typeof mailbox.role === 'string' ? mailbox.role.trim().toLowerCase() : '';
  if (role && PROTECTED_MAILBOX_ROLES.has(role)) {
    throw new Error(`Refusing to delete protected system mailbox with role "${mailbox.role}"`);
  }

  const name = typeof mailbox.name === 'string' ? mailbox.name.trim().toLowerCase() : '';
  if (!role && name && PROTECTED_MAILBOX_NAMES.has(name)) {
    throw new Error(`Refusing to delete protected mailbox "${mailbox.name}"`);
  }
}

// Mail (JMAP)
mailTool(
  'list_mailboxes',
  {
    title: 'List Mailboxes',
    description: 'List mailboxes/folders (JMAP)',
    annotations: { readOnlyHint: true },
  },
  async () => {
    const c = getJmapClient();
    const mailboxes = await c.listMailboxes();
    return asText(mailboxes);
  }
);

mailTool(
  'create_mailbox',
  {
    title: 'Create Mailbox',
    description: 'Create a mailbox/folder (label) (JMAP)',
    inputSchema: {
      name: z.string().min(1).describe('Mailbox name'),
      parentId: z.string().min(1).optional().describe('Optional parent mailbox id'),
      role: z.string().min(1).optional().describe('Optional mailbox role (use only for special system-like mailboxes)'),
      sortOrder: z.number().int().optional().describe('Optional sort order'),
      isSubscribed: z.boolean().optional().describe('Optional subscribed flag'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ name, parentId, role, sortOrder, isSubscribed }) => {
    const c = getJmapClient();
    const created = await c.createMailbox({ name, parentId, role, sortOrder, isSubscribed });
    return asText(created);
  }
);

mailTool(
  'update_mailbox',
  {
    title: 'Update Mailbox',
    description: 'Update mailbox properties (JMAP)',
    inputSchema: {
      mailboxId: z.string().min(1),
      name: z.string().min(1).optional(),
      parentId: z.string().min(1).nullable().optional(),
      sortOrder: z.number().int().optional(),
      isSubscribed: z.boolean().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async ({ mailboxId, name, parentId, sortOrder, isSubscribed }) => {
    if (
      name === undefined &&
      parentId === undefined &&
      sortOrder === undefined &&
      isSubscribed === undefined
    ) {
      throw new Error('At least one mailbox field must be provided');
    }
    const c = getJmapClient();
    const updated = await c.updateMailbox(mailboxId, {
      ...(name !== undefined ? { name } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      ...(isSubscribed !== undefined ? { isSubscribed } : {}),
    });
    return asText(updated);
  }
);

mailTool(
  'delete_mailbox',
  {
    title: 'Delete Mailbox',
    description: 'Delete a mailbox/folder (label) (JMAP)',
    inputSchema: { mailboxId: z.string().min(1) },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ mailboxId }) => {
    const c = getJmapClient();
    const mailboxes = await c.listMailboxes();
    assertMailboxCanBeDeleted(mailboxes, mailboxId);
    await c.deleteMailbox(mailboxId);
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

mailTool(
  'list_emails',
  {
    title: 'List Emails',
    description: 'List emails from a mailbox (JMAP). You MUST call list_mailboxes first to get the mailbox ID — pass the id field, not the name.',
    inputSchema: {
      mailboxId: z.string().optional().describe('Mailbox ID from list_mailboxes (e.g. "P-F"). Do NOT pass a name like "Inbox". If omitted, returns emails from ALL mailboxes.'),
      limit: z.number().int().min(1).max(200).default(20).describe('Max emails to return'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ mailboxId, limit }) => {
    const c = getJmapClient();
    const emails = await c.listEmails(mailboxId, limit);
    return asText(emails);
  }
);

mailTool(
  'get_email',
  {
    title: 'Get Email',
    description: 'Get an email by id (JMAP)',
    inputSchema: { emailId: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ emailId }) => {
    const c = getJmapClient();
    const email = await c.getEmail(emailId);
    return asText(email);
  }
);

mailTool(
  'search_emails',
  {
    title: 'Search Emails',
    description: 'Search emails by full-text query (JMAP)',
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).default(20),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    const c = getJmapClient();
    const emails = await c.searchEmails(query, limit);
    return asText(emails);
  }
);

mailTool(
  'send_email',
  {
    title: 'Send Email',
    description: 'Send an email (JMAP)',
    inputSchema: {
      to: z.array(z.string().email()).min(1),
      cc: z.array(z.string().email()).optional(),
      bcc: z.array(z.string().email()).optional(),
      from: z.string().email().optional(),
      subject: z.string().min(1),
      textBody: z.string().optional(),
      htmlBody: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ to, cc, bcc, from, subject, textBody, htmlBody }) => {
    const c = getJmapClient();
    const r = await c.sendEmail({ to, cc, bcc, from, subject, textBody, htmlBody });
    return {
      content: [{ type: 'text', text: `Email sent. submissionId=${r.submissionId}${r.emailId ? ` emailId=${r.emailId}` : ''}` }],
    };
  }
);

mailTool(
  'mark_email_read',
  {
    title: 'Mark Email Read/Unread',
    description: 'Mark an email read/unread (JMAP)',
    inputSchema: {
      emailId: z.string().min(1),
      read: z.boolean().default(true),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async ({ emailId, read }) => {
    const c = getJmapClient();
    await c.markEmailRead(emailId, read);
    return { content: [{ type: 'text', text: `OK: ${read ? 'read' : 'unread'}` }] };
  }
);

mailTool(
  'move_email',
  {
    title: 'Move Email',
    description: 'Move an email to another mailbox (JMAP). Call list_mailboxes first to get the target mailbox ID.',
    inputSchema: {
      emailId: z.string().min(1),
      targetMailboxId: z.string().min(1).describe('Mailbox ID from list_mailboxes (e.g. "P1-"). Do NOT pass a name like "Trash".'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async ({ emailId, targetMailboxId }) => {
    const c = getJmapClient();
    await c.moveEmail(emailId, targetMailboxId);
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

mailTool(
  'delete_email',
  {
    title: 'Delete Email',
    description: 'Delete an email (moves to Trash) (JMAP)',
    inputSchema: { emailId: z.string().min(1) },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ emailId }) => {
    const c = getJmapClient();
    await c.deleteEmail(emailId);
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

mailTool(
  'get_email_attachments',
  {
    title: 'List Email Attachments',
    description: 'List attachments for an email (JMAP)',
    inputSchema: { emailId: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ emailId }) => {
    const c = getJmapClient();
    const attachments = await c.getEmailAttachments(emailId);
    return asText(attachments);
  }
);

mailTool(
  'download_attachment',
  {
    title: 'Get Attachment Download URL',
    description: 'Get a download URL for an attachment (JMAP)',
    inputSchema: { emailId: z.string().min(1), attachmentId: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ emailId, attachmentId }) => {
    const c = getJmapClient();
    const url = await c.getAttachmentDownloadUrl(emailId, attachmentId);
    return { content: [{ type: 'text', text: url }] };
  }
);

// Calendar (CalDAV)
calendarTool(
  'list_calendars',
  {
    title: 'List Calendars',
    description: 'List calendars (CalDAV)',
    annotations: { readOnlyHint: true },
  },
  async () => {
    const mapped = await listCalendarsWithRights();
    return asText(mapped);
  }
);

calendarTool(
  'create_calendar',
  {
    title: 'Create Calendar',
    description: 'Create a new calendar collection (CalDAV)',
    inputSchema: {
      name: z.string().min(1).describe('Display name for the new calendar'),
      description: z.string().optional().describe('Calendar description'),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Calendar color as CSS hex (e.g. #FF0000)'),
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone (e.g. America/New_York). Defaults to machine timezone.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ name, description, color, timezone }) => {
    const { caldav } = getDavClients();
    await caldav.login();
    const homeUrl = caldav.account?.homeUrl;
    if (!homeUrl) throw new Error('Could not determine calendar home URL');

    const tz = timezone || getMachineTimezone();
    if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);

    const id = crypto.randomUUID();
    const url = `${homeUrl}${id}/`;

    const props: Record<string, any> = { displayname: name };
    if (description) props['c:calendar-description'] = description;
    if (color) props['ca:calendar-color'] = color;
    props['c:calendar-timezone'] = buildCalendarTimezoneProperty(tz);

    await caldav.makeCalendar({ url, props });
    return asText({ calendarId: url, name, timezone: tz });
  }
);

calendarTool(
  'update_calendar',
  {
    title: 'Update Calendar',
    description: 'Update calendar properties (name, description, color, timezone) (CalDAV)',
    inputSchema: {
      calendarId: z.string().min(1).describe('Calendar URL from list_calendars'),
      name: z.string().min(1).optional().describe('New display name'),
      description: z.string().optional().describe('New description'),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('New color as CSS hex (e.g. #FF0000)'),
      timezone: z.string().optional().describe('IANA timezone (e.g. America/New_York)'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async ({ calendarId, name, description, color, timezone }) => {
    if (name === undefined && description === undefined && color === undefined && timezone === undefined) {
      throw new Error('At least one property (name, description, color, timezone) must be provided');
    }

    if (timezone !== undefined && !isValidTimezone(timezone)) {
      throw new Error(`Invalid timezone: ${timezone}`);
    }

    const { caldav } = getDavClients();
    await caldav.login();

    const calendars = await caldav.fetchCalendars();
    const calendar = (calendars || []).find((c: any) => c.url === calendarId);
    if (!calendar) throw new Error('Calendar not found');

    const rights = await getCalendarRights(caldav, calendarId);
    if (rights && !rights.canWrite) {
      throw new Error('This calendar is read-only.');
    }

    const setProps: Record<string, any> = {};
    if (name !== undefined) setProps['displayname'] = name;
    if (description !== undefined) setProps['c:calendar-description'] = description;
    if (color !== undefined) setProps['ca:calendar-color'] = color;
    if (timezone !== undefined) setProps['c:calendar-timezone'] = buildCalendarTimezoneProperty(timezone);

    await caldav.davRequest({
      url: calendarId,
      init: {
        method: 'PROPPATCH',
        namespace: 'd',
        body: {
          propertyupdate: {
            _attributes: {
              'xmlns:d': 'DAV:',
              'xmlns:c': 'urn:ietf:params:xml:ns:caldav',
              'xmlns:ca': 'http://apple.com/ns/ical/',
            },
            set: { prop: setProps },
          },
        },
      },
    });

    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

calendarTool(
  'delete_calendar',
  {
    title: 'Delete Calendar',
    description: 'Delete a calendar collection (CalDAV). Refuses to delete the last remaining calendar.',
    inputSchema: {
      calendarId: z.string().min(1).describe('Calendar URL from list_calendars'),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ calendarId }) => {
    const { caldav } = getDavClients();
    await caldav.login();

    const calendars = await caldav.fetchCalendars();
    const calendar = (calendars || []).find((c: any) => c.url === calendarId);
    if (!calendar) throw new Error('Calendar not found');

    if ((calendars || []).length <= 1) {
      throw new Error('Refusing to delete the last remaining calendar.');
    }

    await caldav.deleteObject({ url: calendarId });
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

calendarTool(
  'get_calendar_event',
  {
    title: 'Get Calendar Event',
    description: 'Get a calendar event by id (event URL) (CalDAV)',
    inputSchema: { eventId: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ eventId }) => {
    const { caldav } = getDavClients();
    await caldav.login();
    const calendars = await caldav.fetchCalendars();
    const calendar = (calendars || []).find((c: any) => typeof c.url === 'string' && eventId.startsWith(c.url));
    if (!calendar) throw new Error('Calendar for event not found');
    const objs = await caldav.fetchCalendarObjects({ calendar, objectUrls: [eventId], useMultiGet: true });
    const o = (objs || [])[0];
    if (!o) throw new Error('Event not found');
    const out = {
      id: o.url,
      url: o.url,
      etag: o.etag,
      summary: typeof o.data === 'string' ? parseIcsSummary(o.data) : undefined,
      ical: o.data,
    };
    return asText(out);
  }
);

// Zod schema that accepts ISO 8601 with or without timezone offset.
const isoDatetime = z.union([
  z.string().datetime({ offset: true }),
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'ISO 8601 datetime (YYYY-MM-DDTHH:MM:SS)'),
]);

calendarTool(
  'list_calendar_events',
  {
    title: 'List Calendar Events',
    description: 'List calendar events (CalDAV). Time range is normalized to UTC. Returns minimal parsed summaries + raw iCal.',
    inputSchema: {
      calendarId: z.string().min(1).describe('Calendar id (calendar URL) from list_calendars'),
      timeRangeStart: isoDatetime
        .optional()
        .describe('ISO 8601 datetime. Offset optional — naive times use the calendar timezone (or machine default).'),
      timeRangeEnd: isoDatetime
        .optional()
        .describe('ISO 8601 datetime. Offset optional — naive times use the calendar timezone (or machine default).'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ calendarId, timeRangeStart, timeRangeEnd, limit }) => {
    const { caldav } = getDavClients();
    await caldav.login();
    const calendars = await caldav.fetchCalendars();
    const calendar = (calendars || []).find((c: any) => c.url === calendarId);
    if (!calendar) throw new Error('Calendar not found');

    const params: any = { calendar };
    if (timeRangeStart && timeRangeEnd) {
      const tz = resolveTimezone(extractCalendarTimezone(calendar.timezone));
      params.timeRange = {
        start: ensureOffsetAware(timeRangeStart, tz),
        end: ensureOffsetAware(timeRangeEnd, tz),
      };
    }
    const objs = await caldav.fetchCalendarObjects(params);
    const sliced = (objs || []).slice(0, limit);
    const out = sliced.map((o: any) => ({
      id: o.url,
      url: o.url,
      etag: o.etag,
      summary: typeof o.data === 'string' ? parseIcsSummary(o.data) : undefined,
      ical: o.data,
    }));
    return asText(out);
  }
);

calendarTool(
  'create_calendar_event',
  {
    title: 'Create Calendar Event',
    description: 'Create a calendar event (CalDAV). Event times are stored as UTC. Naive datetimes (no offset) are interpreted in the calendar timezone (or machine default).',
    inputSchema: {
      calendarId: z.string().min(1).describe('Calendar id (calendar URL) from list_calendars'),
      title: z.string().min(1),
      start: isoDatetime.describe('ISO 8601 datetime. Offset optional — naive times use the calendar timezone (or machine default).'),
      end: isoDatetime.describe('ISO 8601 datetime. Offset optional — naive times use the calendar timezone (or machine default).'),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z
        .array(z.object({ email: z.string().email(), name: z.string().optional() }))
        .optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ calendarId, title, start, end, description, location, attendees }) => {
    const { caldav } = getDavClients();
    await caldav.login();
    const calendars = await caldav.fetchCalendars();
    const calendar = (calendars || []).find((c: any) => c.url === calendarId);
    if (!calendar) throw new Error('Calendar not found');

    const rights = await getCalendarRights(caldav, calendar.url);
    if (rights && !rights.canWrite) {
      throw new Error('This calendar is read-only. Pick a calendar with canWrite=true from list_calendars.');
    }

    const organizerEmail = getOrganizerEmail();
    if (!organizerEmail) {
      throw new Error('Missing organizer email. Set DAV_ORGANIZER_EMAIL (or DAV_USERNAME).');
    }

    const tz = resolveTimezone(extractCalendarTimezone(calendar.timezone));

    const { uid, ics, filename } = buildIcsEvent({
      title,
      start: ensureOffsetAware(start, tz),
      end: ensureOffsetAware(end, tz),
      description,
      location,
      organizerEmail,
      attendees,
    });
    const res = await caldav.createCalendarObject({ calendar, iCalString: ics, filename });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 403) {
        throw new Error(
          `CalDAV create failed (403 Forbidden). This usually means you're targeting a read-only calendar/share. Body: ${body.slice(0, 500)}`
        );
      }
      throw new Error(`CalDAV create failed (${res.status} ${res.statusText}). Body: ${body.slice(0, 500)}`);
    }
    const eventUrl = new URL(filename, calendar.url).href;
    return { content: [{ type: 'text', text: JSON.stringify({ uid, eventId: eventUrl }, null, 2) }] };
  }
);

calendarTool(
  'update_calendar_event',
  {
    title: 'Update Calendar Event',
    description: 'Update a calendar event by id (event URL) (CalDAV). Provide a full iCalendar string.',
    inputSchema: {
      eventId: z.string().min(1),
      iCalString: z.string().min(1),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ eventId, iCalString }) => {
    const { caldav } = getDavClients();
    await caldav.login();
    const calendars = await caldav.fetchCalendars();
    const calendar = (calendars || []).find((c: any) => typeof c.url === 'string' && eventId.startsWith(c.url));
    if (!calendar) throw new Error('Calendar for event not found');

    const objs = await caldav.fetchCalendarObjects({ calendar, objectUrls: [eventId], useMultiGet: true });
    const existing = (objs || [])[0];
    if (!existing) throw new Error('Event not found');

    const res = await caldav.updateCalendarObject({
      calendarObject: {
        url: existing.url,
        etag: existing.etag,
        data: iCalString,
      },
    });
    if (!res.ok) throw new Error(`CalDAV update failed (${res.status})`);
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

calendarTool(
  'delete_calendar_event',
  {
    title: 'Delete Calendar Event',
    description: 'Delete a calendar event by id (event URL) (CalDAV)',
    inputSchema: { eventId: z.string().min(1) },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ eventId }) => {
    const { caldav } = getDavClients();
    await caldav.login();
    const calendars = await caldav.fetchCalendars();
    const calendar = (calendars || []).find((c: any) => typeof c.url === 'string' && eventId.startsWith(c.url));
    if (!calendar) throw new Error('Calendar for event not found');

    const objs = await caldav.fetchCalendarObjects({ calendar, objectUrls: [eventId], useMultiGet: true });
    const existing = (objs || [])[0];
    if (!existing) throw new Error('Event not found');

    const res = await caldav.deleteCalendarObject({
      calendarObject: {
        url: existing.url,
        etag: existing.etag,
      },
    });
    if (!res.ok) throw new Error(`CalDAV delete failed (${res.status})`);
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

// Contacts (CardDAV)
contactTool(
  'list_contact_lists',
  {
    title: 'List Address Books',
    description: 'List contact address books (CardDAV)',
    annotations: { readOnlyHint: true },
  },
  async () => {
    const { carddav } = getDavClients();
    await carddav.login();
    const books = await carddav.fetchAddressBooks();
    const mapped = (books || []).map((b: any) => ({ id: b.url, name: b.displayName, url: b.url }));
    return asText(mapped);
  }
);

contactTool(
  'search_contacts',
  {
    title: 'Search Contacts',
    description: 'Search contacts (best-effort, client-side substring match) (CardDAV)',
    inputSchema: {
      query: z.string().min(1),
      addressBookId: z.string().min(1).optional().describe('Limit search to a specific address book URL (optional)'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, addressBookId, limit }) => {
    const q = query.toLowerCase();
    const { carddav } = getDavClients();
    await carddav.login();
    const books = await carddav.fetchAddressBooks();

    const targetBooks = addressBookId ? (books || []).filter((b: any) => b.url === addressBookId) : (books || []);
    if (!targetBooks.length) throw new Error('No address books found');

    const matches: any[] = [];
    for (const book of targetBooks) {
      const vcards = await carddav.fetchVCards({ addressBook: book });
      for (const v of vcards || []) {
        if (matches.length >= limit) break;
        const summary = typeof v.data === 'string' ? parseVCardSummary(v.data) : undefined;
        const hay = JSON.stringify(summary || '').toLowerCase();
        if (hay.includes(q)) {
          matches.push({
            id: v.url,
            url: v.url,
            etag: v.etag,
            summary,
          });
        }
      }
      if (matches.length >= limit) break;
    }

    return asText(matches);
  }
);

contactTool(
  'list_contacts',
  {
    title: 'List Contacts',
    description: 'List contacts from an address book (CardDAV). Returns minimal parsed summaries + raw vCard.',
    inputSchema: {
      addressBookId: z.string().min(1).describe('Address book id (URL) from list_contact_lists'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ addressBookId, limit }) => {
    const { carddav } = getDavClients();
    await carddav.login();
    const books = await carddav.fetchAddressBooks();
    const book = (books || []).find((b: any) => b.url === addressBookId);
    if (!book) throw new Error('Address book not found');
    const vcards = await carddav.fetchVCards({ addressBook: book });
    const sliced = (vcards || []).slice(0, limit);
    const out = sliced.map((v: any) => ({
      id: v.url,
      url: v.url,
      etag: v.etag,
      summary: typeof v.data === 'string' ? parseVCardSummary(v.data) : undefined,
      vcard: v.data,
    }));
    return asText(out);
  }
);

contactTool(
  'get_contact',
  {
    title: 'Get Contact',
    description: 'Get a contact by id (vCard URL) (CardDAV)',
    inputSchema: { contactId: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ contactId }) => {
    const { carddav } = getDavClients();
    await carddav.login();
    const books = await carddav.fetchAddressBooks();
    // We can multi-get without knowing the address book, but tsdav wants an addressBook.
    // Best-effort: find the address book whose URL prefixes the vCard URL.
    const book = (books || []).find((b: any) => typeof b.url === 'string' && contactId.startsWith(b.url));
    if (!book) throw new Error('Address book for contact not found');
    const [v] = await carddav.fetchVCards({ addressBook: book, objectUrls: [contactId] });
    if (!v) throw new Error('Contact not found');
    const out = {
      id: v.url,
      url: v.url,
      etag: v.etag,
      summary: typeof v.data === 'string' ? parseVCardSummary(v.data) : undefined,
      vcard: v.data,
    };
    return asText(out);
  }
);

contactTool(
  'create_contact',
  {
    title: 'Create Contact',
    description: 'Create a new contact (CardDAV)',
    inputSchema: {
      addressBookId: z.string().min(1).describe('Address book id (URL) from list_contact_lists'),
      fullName: z.string().min(1),
      emails: z.array(z.string().email()).optional(),
      phones: z.array(z.string()).optional(),
      note: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ addressBookId, fullName, emails, phones, note }) => {
    const { carddav } = getDavClients();
    await carddav.login();
    const books = await carddav.fetchAddressBooks();
    const book = (books || []).find((b: any) => b.url === addressBookId);
    if (!book) throw new Error('Address book not found');
    const { uid, vcard, filename } = buildVCard({ fullName, emails, phones, note });
    const res = await carddav.createVCard({ addressBook: book, vCardString: vcard, filename });
    if (!res.ok) {
      throw new Error(`CardDAV create failed (${res.status})`);
    }
    const contactUrl = new URL(filename, book.url).href;
    return { content: [{ type: 'text', text: JSON.stringify({ uid, contactId: contactUrl }, null, 2) }] };
  }
);

contactTool(
  'update_contact',
  {
    title: 'Update Contact',
    description: 'Update a contact by id (vCard URL) (CardDAV). Provide a full vCard string.',
    inputSchema: {
      contactId: z.string().min(1),
      vCardString: z.string().min(1),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ contactId, vCardString }) => {
    const { carddav } = getDavClients();
    await carddav.login();
    const books = await carddav.fetchAddressBooks();
    const book = (books || []).find((b: any) => typeof b.url === 'string' && contactId.startsWith(b.url));
    if (!book) throw new Error('Address book for contact not found');
    const [existing] = await carddav.fetchVCards({ addressBook: book, objectUrls: [contactId], useMultiGet: true });
    if (!existing) throw new Error('Contact not found');

    const res = await carddav.updateVCard({
      vCard: {
        url: existing.url,
        etag: existing.etag,
        data: vCardString,
      },
    });
    if (!res.ok) throw new Error(`CardDAV update failed (${res.status})`);
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

contactTool(
  'delete_contact',
  {
    title: 'Delete Contact',
    description: 'Delete a contact by id (vCard URL) (CardDAV)',
    inputSchema: { contactId: z.string().min(1) },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ contactId }) => {
    const { carddav } = getDavClients();
    await carddav.login();
    const books = await carddav.fetchAddressBooks();
    const book = (books || []).find((b: any) => typeof b.url === 'string' && contactId.startsWith(b.url));
    if (!book) throw new Error('Address book for contact not found');
    const [existing] = await carddav.fetchVCards({ addressBook: book, objectUrls: [contactId], useMultiGet: true });
    if (!existing) throw new Error('Contact not found');

    const res = await carddav.deleteVCard({
      vCard: {
        url: existing.url,
        etag: existing.etag,
      },
    });
    if (!res.ok) throw new Error(`CardDAV delete failed (${res.status})`);
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`jmap-dav-mcp running on stdio (domains: ${[...domains].join(', ')})`);
}

main().catch((err) => {
  console.error('jmap-dav-mcp failed to start');
  if (process.env.DEBUG) {
    console.error(err instanceof Error ? err.stack : String(err));
  }
  process.exit(1);
});
