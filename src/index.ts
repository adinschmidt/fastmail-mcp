#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadDavConfig, loadFastmailAuthConfig } from './config.js';
import { FastmailJmapAuth } from './jmap/auth.js';
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
  name: 'fastmail-mcp',
  version: '0.1.0',
});

let jmapClient: JmapClient | null = null;
let davClients: DavClients | null = null;

function getJmapClient(): JmapClient {
  if (jmapClient) return jmapClient;
  const cfg = loadFastmailAuthConfig();
  const auth = new FastmailJmapAuth(cfg);
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
server.tool('list_mailboxes', 'List Fastmail mailboxes (JMAP)', async () => {
  const c = getJmapClient();
  const mailboxes = await c.listMailboxes();
  return asText(mailboxes);
});

server.tool(
  'create_mailbox',
  'Create a mailbox/folder (label) (JMAP)',
  {
    name: z.string().min(1).describe('Mailbox name'),
    parentId: z.string().min(1).optional().describe('Optional parent mailbox id'),
    role: z.string().min(1).optional().describe('Optional mailbox role (use only for special system-like mailboxes)'),
    sortOrder: z.number().int().optional().describe('Optional sort order'),
    isSubscribed: z.boolean().optional().describe('Optional subscribed flag'),
  },
  async ({ name, parentId, role, sortOrder, isSubscribed }) => {
    const c = getJmapClient();
    const created = await c.createMailbox({ name, parentId, role, sortOrder, isSubscribed });
    return asText(created);
  }
);

server.tool(
  'update_mailbox',
  'Update mailbox properties (JMAP)',
  {
    mailboxId: z.string().min(1),
    name: z.string().min(1).optional(),
    parentId: z.string().min(1).nullable().optional(),
    sortOrder: z.number().int().optional(),
    isSubscribed: z.boolean().optional(),
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

server.tool(
  'delete_mailbox',
  'Delete a mailbox/folder (label) (JMAP)',
  { mailboxId: z.string().min(1) },
  async ({ mailboxId }) => {
    const c = getJmapClient();
    const mailboxes = await c.listMailboxes();
    assertMailboxCanBeDeleted(mailboxes, mailboxId);
    await c.deleteMailbox(mailboxId);
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

server.tool(
  'list_emails',
  'List emails from a mailbox (JMAP). You MUST call list_mailboxes first to get the mailbox ID — pass the id field, not the name.',
  {
    mailboxId: z.string().optional().describe('Mailbox ID from list_mailboxes (e.g. "P-F"). Do NOT pass a name like "Inbox". If omitted, returns emails from ALL mailboxes.'),
    limit: z.number().int().min(1).max(200).default(20).describe('Max emails to return'),
  },
  async ({ mailboxId, limit }) => {
    const c = getJmapClient();
    const emails = await c.listEmails(mailboxId, limit);
    return asText(emails);
  }
);

server.tool(
  'get_email',
  'Get an email by id (JMAP)',
  { emailId: z.string().min(1) },
  async ({ emailId }) => {
    const c = getJmapClient();
    const email = await c.getEmail(emailId);
    return asText(email);
  }
);

server.tool(
  'search_emails',
  'Search emails by full-text query (JMAP)',
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).default(20),
  },
  async ({ query, limit }) => {
    const c = getJmapClient();
    const emails = await c.searchEmails(query, limit);
    return asText(emails);
  }
);

server.tool(
  'send_email',
  'Send an email (JMAP)',
  {
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    from: z.string().email().optional(),
    subject: z.string().min(1),
    textBody: z.string().optional(),
    htmlBody: z.string().optional(),
  },
  async ({ to, cc, bcc, from, subject, textBody, htmlBody }) => {
    const c = getJmapClient();
    const r = await c.sendEmail({ to, cc, bcc, from, subject, textBody, htmlBody });
    return {
      content: [{ type: 'text', text: `Email sent. submissionId=${r.submissionId}${r.emailId ? ` emailId=${r.emailId}` : ''}` }],
    };
  }
);

server.tool(
  'mark_email_read',
  'Mark an email read/unread (JMAP)',
  {
    emailId: z.string().min(1),
    read: z.boolean().default(true),
  },
  async ({ emailId, read }) => {
    const c = getJmapClient();
    await c.markEmailRead(emailId, read);
    return { content: [{ type: 'text', text: `OK: ${read ? 'read' : 'unread'}` }] };
  }
);

server.tool(
  'move_email',
  'Move an email to another mailbox (JMAP). Call list_mailboxes first to get the target mailbox ID.',
  {
    emailId: z.string().min(1),
    targetMailboxId: z.string().min(1).describe('Mailbox ID from list_mailboxes (e.g. "P1-"). Do NOT pass a name like "Trash".'),
  },
  async ({ emailId, targetMailboxId }) => {
    const c = getJmapClient();
    await c.moveEmail(emailId, targetMailboxId);
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

server.tool(
  'delete_email',
  'Delete an email (moves to Trash) (JMAP)',
  { emailId: z.string().min(1) },
  async ({ emailId }) => {
    const c = getJmapClient();
    await c.deleteEmail(emailId);
    return { content: [{ type: 'text', text: 'OK' }] };
  }
);

server.tool(
  'get_email_attachments',
  'List attachments for an email (JMAP)',
  { emailId: z.string().min(1) },
  async ({ emailId }) => {
    const c = getJmapClient();
    const attachments = await c.getEmailAttachments(emailId);
    return asText(attachments);
  }
);

server.tool(
  'download_attachment',
  'Get a download URL for an attachment (JMAP)',
  { emailId: z.string().min(1), attachmentId: z.string().min(1) },
  async ({ emailId, attachmentId }) => {
    const c = getJmapClient();
    const url = await c.getAttachmentDownloadUrl(emailId, attachmentId);
    return { content: [{ type: 'text', text: url }] };
  }
);

// Calendar (CalDAV)
server.tool('list_calendars', 'List calendars (CalDAV)', async () => {
  const mapped = await listCalendarsWithRights();
  return asText(mapped);
});

// Back-compat with dav-mcp-server naming
server.tool('get_my_fastmail_calendars', 'Alias for list_calendars (CalDAV)', async () => {
  const mapped = await listCalendarsWithRights();
  return asText(mapped);
});

server.tool(
  'create_calendar',
  'Create a new calendar collection (CalDAV)',
  {
    name: z.string().min(1).describe('Display name for the new calendar'),
    description: z.string().optional().describe('Calendar description'),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Calendar color as CSS hex (e.g. #FF0000)'),
    timezone: z
      .string()
      .optional()
      .describe('IANA timezone (e.g. America/New_York). Defaults to machine timezone.'),
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

server.tool(
  'update_calendar',
  'Update calendar properties (name, description, color, timezone) (CalDAV)',
  {
    calendarId: z.string().min(1).describe('Calendar URL from list_calendars'),
    name: z.string().min(1).optional().describe('New display name'),
    description: z.string().optional().describe('New description'),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('New color as CSS hex (e.g. #FF0000)'),
    timezone: z.string().optional().describe('IANA timezone (e.g. America/New_York)'),
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

server.tool(
  'delete_calendar',
  'Delete a calendar collection (CalDAV). Refuses to delete the last remaining calendar.',
  {
    calendarId: z.string().min(1).describe('Calendar URL from list_calendars'),
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

server.tool(
  'get_calendar_event',
  'Get a calendar event by id (event URL) (CalDAV)',
  { eventId: z.string().min(1) },
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

server.tool(
  'list_calendar_events',
  'List calendar events (CalDAV). Time range is normalized to UTC. Returns minimal parsed summaries + raw iCal.',
  {
    calendarId: z.string().min(1).describe('Calendar id (calendar URL) from list_calendars'),
    timeRangeStart: isoDatetime
      .optional()
      .describe('ISO 8601 datetime. Offset optional — naive times use the calendar timezone (or machine default).'),
    timeRangeEnd: isoDatetime
      .optional()
      .describe('ISO 8601 datetime. Offset optional — naive times use the calendar timezone (or machine default).'),
    limit: z.number().int().min(1).max(500).default(50),
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

// Back-compat with dav-mcp-server naming
server.tool(
  'get_calendar_events_from_fastmail',
  'Alias for list_calendar_events (CalDAV)',
  {
    calendarUrl: z.string().min(1),
    timeRangeStart: isoDatetime.optional(),
    timeRangeEnd: isoDatetime.optional(),
    limit: z.number().int().min(1).max(500).default(50),
  },
  async ({ calendarUrl, timeRangeStart, timeRangeEnd, limit }) => {
    const { caldav } = getDavClients();
    await caldav.login();
    const calendars = await caldav.fetchCalendars();
    const calendar = (calendars || []).find((c: any) => c.url === calendarUrl);
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

server.tool(
  'create_calendar_event',
  'Create a calendar event (CalDAV). Event times are stored as UTC. Naive datetimes (no offset) are interpreted in the calendar timezone (or machine default).',
  {
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

    const organizerEmail =
      process.env.FASTMAIL_ORGANIZER_EMAIL || process.env.FASTMAIL_USERNAME || process.env.FASTMAIL_DAV_USERNAME;
    if (!organizerEmail) {
      throw new Error('Missing organizer email. Set FASTMAIL_ORGANIZER_EMAIL (or FASTMAIL_USERNAME).');
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

server.tool(
  'update_calendar_event',
  'Update a calendar event by id (event URL) (CalDAV). Provide a full iCalendar string.',
  {
    eventId: z.string().min(1),
    iCalString: z.string().min(1),
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

server.tool(
  'delete_calendar_event',
  'Delete a calendar event by id (event URL) (CalDAV)',
  { eventId: z.string().min(1) },
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
server.tool('list_contact_lists', 'List contact address books (CardDAV)', async () => {
  const { carddav } = getDavClients();
  await carddav.login();
  const books = await carddav.fetchAddressBooks();
  const mapped = (books || []).map((b: any) => ({ id: b.url, name: b.displayName, url: b.url }));
  return asText(mapped);
});

// Back-compat with dav-mcp-server naming
server.tool('get_my_fastmail_contact_lists', 'Alias for list_contact_lists (CardDAV)', async () => {
  const { carddav } = getDavClients();
  await carddav.login();
  const books = await carddav.fetchAddressBooks();
  const mapped = (books || []).map((b: any) => ({ id: b.url, name: b.displayName, url: b.url }));
  return asText(mapped);
});

server.tool(
  'search_contacts',
  'Search contacts (best-effort, client-side substring match) (CardDAV)',
  {
    query: z.string().min(1),
    addressBookId: z.string().min(1).optional().describe('Limit search to a specific address book URL (optional)'),
    limit: z.number().int().min(1).max(500).default(50),
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

server.tool(
  'list_contacts',
  'List contacts from an address book (CardDAV). Returns minimal parsed summaries + raw vCard.',
  {
    addressBookId: z.string().min(1).describe('Address book id (URL) from list_contact_lists'),
    limit: z.number().int().min(1).max(500).default(50),
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

// Back-compat with dav-mcp-server naming
server.tool(
  'get_contacts_from_fastmail_list',
  'Alias for list_contacts (CardDAV)',
  {
    addressBookUrl: z.string().min(1),
    limit: z.number().int().min(1).max(500).default(50),
  },
  async ({ addressBookUrl, limit }) => {
    const { carddav } = getDavClients();
    await carddav.login();
    const books = await carddav.fetchAddressBooks();
    const book = (books || []).find((b: any) => b.url === addressBookUrl);
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

server.tool(
  'get_contact',
  'Get a contact by id (vCard URL) (CardDAV)',
  { contactId: z.string().min(1) },
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

server.tool(
  'create_contact',
  'Create a new contact (CardDAV)',
  {
    addressBookId: z.string().min(1).describe('Address book id (URL) from list_contact_lists'),
    fullName: z.string().min(1),
    emails: z.array(z.string().email()).optional(),
    phones: z.array(z.string()).optional(),
    note: z.string().optional(),
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

server.tool(
  'update_contact',
  'Update a contact by id (vCard URL) (CardDAV). Provide a full vCard string.',
  {
    contactId: z.string().min(1),
    vCardString: z.string().min(1),
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

server.tool(
  'delete_contact',
  'Delete a contact by id (vCard URL) (CardDAV)',
  { contactId: z.string().min(1) },
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
  console.error('fastmail-mcp running on stdio');
}

main().catch((err) => {
  console.error('fastmail-mcp failed to start');
  if (process.env.DEBUG) {
    console.error(err instanceof Error ? err.stack : String(err));
  }
  process.exit(1);
});
