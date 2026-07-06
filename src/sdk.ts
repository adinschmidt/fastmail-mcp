/**
 * JMAP/DAV SDK — importable TypeScript API for mail (JMAP), calendar (CalDAV),
 * and contacts (CardDAV). Works with any compliant server; Fastmail works out
 * of the box.
 *
 * Usage:
 *   import * as jmapdav from './jmap-dav-mcp/src/sdk.js';
 *   const emails = await jmapdav.listEmails({ limit: 5 });
 *   console.log(emails);
 *
 * Requires the same env vars as the MCP server:
 *   JMAP_USERNAME + JMAP_PASSWORD (or JMAP_API_TOKEN) + JMAP_BASE_URL for mail;
 *   DAV_USERNAME + DAV_PASSWORD + CALDAV_URL/CARDDAV_URL for calendar/contacts.
 *   Legacy FASTMAIL_* vars are accepted and imply Fastmail server URLs.
 */

import { loadJmapAuthConfig, loadDavConfig, getOrganizerEmail } from './config.js';
import { JmapAuth } from './jmap/auth.js';
import { JmapClient } from './jmap/client.js';
import { createDavClients, type DavClients } from './dav/client.js';
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

// ---------------------------------------------------------------------------
// Lazy singletons
// ---------------------------------------------------------------------------

let _jmap: JmapClient | null = null;
let _dav: DavClients | null = null;

function jmap(): JmapClient {
  if (!_jmap) {
    _jmap = new JmapClient(new JmapAuth(loadJmapAuthConfig()));
  }
  return _jmap;
}

function dav(): DavClients {
  if (!_dav) {
    _dav = createDavClients(loadDavConfig());
  }
  return _dav;
}

// ---------------------------------------------------------------------------
// Internal helpers (lifted from index.ts)
// ---------------------------------------------------------------------------

type DavRights = { privileges: string[]; canRead: boolean; canWrite: boolean };

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
      props: { 'current-user-privilege-set': {} } as any,
    });
    const props = res?.[0]?.props as any;
    const privileges = extractDavPrivileges(props?.currentUserPrivilegeSet);
    if (!privileges.length) return null;
    return computeDavRights(privileges);
  } catch {
    return null;
  }
}

const PROTECTED_MAILBOX_ROLES = new Set([
  'inbox', 'spam', 'trash', 'sent', 'drafts', 'archive', 'junk',
]);

const PROTECTED_MAILBOX_NAMES = new Set([
  'inbox', 'spam', 'junk', 'trash', 'sent', 'drafts', 'archive',
]);

function assertMailboxCanBeDeleted(mailboxes: any[], mailboxId: string): void {
  const mailbox = (mailboxes || []).find((m: any) => m?.id === mailboxId);
  if (!mailbox) throw new Error(`Mailbox not found: ${mailboxId}`);
  const role = typeof mailbox.role === 'string' ? mailbox.role.trim().toLowerCase() : '';
  if (role && PROTECTED_MAILBOX_ROLES.has(role)) {
    throw new Error(`Refusing to delete protected system mailbox with role "${mailbox.role}"`);
  }
  const name = typeof mailbox.name === 'string' ? mailbox.name.trim().toLowerCase() : '';
  if (!role && name && PROTECTED_MAILBOX_NAMES.has(name)) {
    throw new Error(`Refusing to delete protected mailbox "${mailbox.name}"`);
  }
}

// ---------------------------------------------------------------------------
// Mail (JMAP)
// ---------------------------------------------------------------------------

/** List all mailboxes. */
export async function listMailboxes() {
  return jmap().listMailboxes();
}

/** Create a mailbox/folder. */
export async function createMailbox(input: {
  name: string;
  parentId?: string;
  role?: string;
  sortOrder?: number;
  isSubscribed?: boolean;
}) {
  return jmap().createMailbox(input);
}

/** Update mailbox properties. At least one field must be provided. */
export async function updateMailbox(
  mailboxId: string,
  update: {
    name?: string;
    parentId?: string | null;
    sortOrder?: number;
    isSubscribed?: boolean;
  },
) {
  return jmap().updateMailbox(mailboxId, update);
}

/** Delete a mailbox. Refuses to delete protected system mailboxes. */
export async function deleteMailbox(mailboxId: string) {
  const mailboxes = await jmap().listMailboxes();
  assertMailboxCanBeDeleted(mailboxes, mailboxId);
  return jmap().deleteMailbox(mailboxId);
}

/** List emails from a mailbox. Omit mailboxId for all mailboxes. */
export async function listEmails(input?: { mailboxId?: string; limit?: number }) {
  return jmap().listEmails(input?.mailboxId, input?.limit ?? 20);
}

/** Get a single email by id. */
export async function getEmail(emailId: string) {
  return jmap().getEmail(emailId);
}

/** Full-text search for emails. */
export async function searchEmails(input: { query: string; limit?: number }) {
  return jmap().searchEmails(input.query, input.limit ?? 20);
}

/** Send an email. Requires either textBody or htmlBody. */
export async function sendEmail(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  from?: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
}) {
  return jmap().sendEmail(input);
}

/** Mark an email as read or unread. */
export async function markEmailRead(emailId: string, read = true) {
  return jmap().markEmailRead(emailId, read);
}

/** Move an email to another mailbox. */
export async function moveEmail(emailId: string, targetMailboxId: string) {
  return jmap().moveEmail(emailId, targetMailboxId);
}

/** Delete an email (moves to Trash). */
export async function deleteEmail(emailId: string) {
  return jmap().deleteEmail(emailId);
}

/** List attachments for an email. */
export async function getEmailAttachments(emailId: string) {
  return jmap().getEmailAttachments(emailId);
}

/** Get a download URL for an attachment. */
export async function getAttachmentDownloadUrl(emailId: string, attachmentId: string) {
  return jmap().getAttachmentDownloadUrl(emailId, attachmentId);
}

// ---------------------------------------------------------------------------
// Calendar (CalDAV)
// ---------------------------------------------------------------------------

/** List calendars with read/write permissions. */
export async function listCalendars() {
  const { caldav } = dav();
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
    }),
  );
}

/** Create a new calendar collection. */
export async function createCalendar(input: {
  name: string;
  description?: string;
  /** CSS hex color, e.g. #FF0000 */
  color?: string;
  /** IANA timezone, e.g. America/New_York. Defaults to machine timezone. */
  timezone?: string;
}) {
  const { caldav } = dav();
  await caldav.login();
  const homeUrl = caldav.account?.homeUrl;
  if (!homeUrl) throw new Error('Could not determine calendar home URL');

  const tz = input.timezone || getMachineTimezone();
  if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);

  const id = crypto.randomUUID();
  const url = `${homeUrl}${id}/`;

  const props: Record<string, any> = { displayname: input.name };
  if (input.description) props['c:calendar-description'] = input.description;
  if (input.color) props['ca:calendar-color'] = input.color;
  props['c:calendar-timezone'] = buildCalendarTimezoneProperty(tz);

  await caldav.makeCalendar({ url, props });
  return { calendarId: url, name: input.name, timezone: tz };
}

/** Update calendar properties. At least one field must be provided. */
export async function updateCalendar(input: {
  calendarId: string;
  name?: string;
  description?: string;
  color?: string;
  timezone?: string;
}) {
  if (!input.name && !input.description && !input.color && !input.timezone) {
    throw new Error('At least one property (name, description, color, timezone) must be provided');
  }
  if (input.timezone && !isValidTimezone(input.timezone)) {
    throw new Error(`Invalid timezone: ${input.timezone}`);
  }

  const { caldav } = dav();
  await caldav.login();

  const calendars = await caldav.fetchCalendars();
  const calendar = (calendars || []).find((c: any) => c.url === input.calendarId);
  if (!calendar) throw new Error('Calendar not found');

  const rights = await getCalendarRights(caldav, input.calendarId);
  if (rights && !rights.canWrite) throw new Error('This calendar is read-only.');

  const setProps: Record<string, any> = {};
  if (input.name !== undefined) setProps['displayname'] = input.name;
  if (input.description !== undefined) setProps['c:calendar-description'] = input.description;
  if (input.color !== undefined) setProps['ca:calendar-color'] = input.color;
  if (input.timezone !== undefined) setProps['c:calendar-timezone'] = buildCalendarTimezoneProperty(input.timezone);

  await caldav.davRequest({
    url: input.calendarId,
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
}

/** Delete a calendar collection. Refuses to delete the last remaining calendar. */
export async function deleteCalendar(calendarId: string) {
  const { caldav } = dav();
  await caldav.login();

  const calendars = await caldav.fetchCalendars();
  const calendar = (calendars || []).find((c: any) => c.url === calendarId);
  if (!calendar) throw new Error('Calendar not found');
  if ((calendars || []).length <= 1) throw new Error('Refusing to delete the last remaining calendar.');

  await caldav.deleteObject({ url: calendarId });
}

/** Get a single calendar event by its event URL. */
export async function getCalendarEvent(eventId: string) {
  const { caldav } = dav();
  await caldav.login();
  const calendars = await caldav.fetchCalendars();
  const calendar = (calendars || []).find((c: any) => typeof c.url === 'string' && eventId.startsWith(c.url));
  if (!calendar) throw new Error('Calendar for event not found');

  const objs = await caldav.fetchCalendarObjects({ calendar, objectUrls: [eventId], useMultiGet: true });
  const o = (objs || [])[0];
  if (!o) throw new Error('Event not found');

  return {
    id: o.url,
    url: o.url,
    etag: o.etag,
    summary: typeof o.data === 'string' ? parseIcsSummary(o.data) : undefined,
    ical: o.data,
  };
}

/** List calendar events, optionally filtered by a time range. */
export async function listCalendarEvents(input: {
  calendarId: string;
  /** ISO 8601 datetime. Naive times use the calendar timezone (or machine default). */
  timeRangeStart?: string;
  /** ISO 8601 datetime. Naive times use the calendar timezone (or machine default). */
  timeRangeEnd?: string;
  limit?: number;
}) {
  const { caldav } = dav();
  await caldav.login();
  const calendars = await caldav.fetchCalendars();
  const calendar = (calendars || []).find((c: any) => c.url === input.calendarId);
  if (!calendar) throw new Error('Calendar not found');

  const params: any = { calendar };
  if (input.timeRangeStart && input.timeRangeEnd) {
    const tz = resolveTimezone(extractCalendarTimezone(calendar.timezone));
    params.timeRange = {
      start: ensureOffsetAware(input.timeRangeStart, tz),
      end: ensureOffsetAware(input.timeRangeEnd, tz),
    };
  }

  const objs = await caldav.fetchCalendarObjects(params);
  const sliced = (objs || []).slice(0, input.limit ?? 50);
  return sliced.map((o: any) => ({
    id: o.url,
    url: o.url,
    etag: o.etag,
    summary: typeof o.data === 'string' ? parseIcsSummary(o.data) : undefined,
    ical: o.data,
  }));
}

/** Create a calendar event. Times are stored as UTC. */
export async function createCalendarEvent(input: {
  calendarId: string;
  title: string;
  /** ISO 8601 datetime. Naive times use the calendar timezone (or machine default). */
  start: string;
  /** ISO 8601 datetime. Naive times use the calendar timezone (or machine default). */
  end: string;
  description?: string;
  location?: string;
  attendees?: Array<{ email: string; name?: string }>;
}) {
  const { caldav } = dav();
  await caldav.login();
  const calendars = await caldav.fetchCalendars();
  const calendar = (calendars || []).find((c: any) => c.url === input.calendarId);
  if (!calendar) throw new Error('Calendar not found');

  const rights = await getCalendarRights(caldav, calendar.url);
  if (rights && !rights.canWrite) {
    throw new Error('This calendar is read-only. Pick a calendar with canWrite=true from listCalendars.');
  }

  const organizerEmail = getOrganizerEmail();
  if (!organizerEmail) {
    throw new Error('Missing organizer email. Set DAV_ORGANIZER_EMAIL (or DAV_USERNAME).');
  }

  const tz = resolveTimezone(extractCalendarTimezone(calendar.timezone));
  const { uid, ics, filename } = buildIcsEvent({
    title: input.title,
    start: ensureOffsetAware(input.start, tz),
    end: ensureOffsetAware(input.end, tz),
    description: input.description,
    location: input.location,
    organizerEmail,
    attendees: input.attendees,
  });

  const res = await caldav.createCalendarObject({ calendar, iCalString: ics, filename });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error(
        `CalDAV create failed (403 Forbidden). Likely targeting a read-only calendar. Body: ${body.slice(0, 500)}`,
      );
    }
    throw new Error(`CalDAV create failed (${res.status} ${res.statusText}). Body: ${body.slice(0, 500)}`);
  }

  const eventUrl = new URL(filename, calendar.url).href;
  return { uid, eventId: eventUrl };
}

/** Update a calendar event. Provide a full iCalendar string. */
export async function updateCalendarEvent(eventId: string, iCalString: string) {
  const { caldav } = dav();
  await caldav.login();
  const calendars = await caldav.fetchCalendars();
  const calendar = (calendars || []).find((c: any) => typeof c.url === 'string' && eventId.startsWith(c.url));
  if (!calendar) throw new Error('Calendar for event not found');

  const objs = await caldav.fetchCalendarObjects({ calendar, objectUrls: [eventId], useMultiGet: true });
  const existing = (objs || [])[0];
  if (!existing) throw new Error('Event not found');

  const res = await caldav.updateCalendarObject({
    calendarObject: { url: existing.url, etag: existing.etag, data: iCalString },
  });
  if (!res.ok) throw new Error(`CalDAV update failed (${res.status})`);
}

/** Delete a calendar event by its event URL. */
export async function deleteCalendarEvent(eventId: string) {
  const { caldav } = dav();
  await caldav.login();
  const calendars = await caldav.fetchCalendars();
  const calendar = (calendars || []).find((c: any) => typeof c.url === 'string' && eventId.startsWith(c.url));
  if (!calendar) throw new Error('Calendar for event not found');

  const objs = await caldav.fetchCalendarObjects({ calendar, objectUrls: [eventId], useMultiGet: true });
  const existing = (objs || [])[0];
  if (!existing) throw new Error('Event not found');

  const res = await caldav.deleteCalendarObject({
    calendarObject: { url: existing.url, etag: existing.etag },
  });
  if (!res.ok) throw new Error(`CalDAV delete failed (${res.status})`);
}

// ---------------------------------------------------------------------------
// Contacts (CardDAV)
// ---------------------------------------------------------------------------

/** List contact address books. */
export async function listContactLists() {
  const { carddav } = dav();
  await carddav.login();
  const books = await carddav.fetchAddressBooks();
  return (books || []).map((b: any) => ({ id: b.url, name: b.displayName, url: b.url }));
}

/** Search contacts by substring (client-side match). */
export async function searchContacts(input: {
  query: string;
  addressBookId?: string;
  limit?: number;
}) {
  const q = input.query.toLowerCase();
  const limit = input.limit ?? 50;
  const { carddav } = dav();
  await carddav.login();
  const books = await carddav.fetchAddressBooks();

  const targetBooks = input.addressBookId
    ? (books || []).filter((b: any) => b.url === input.addressBookId)
    : (books || []);
  if (!targetBooks.length) throw new Error('No address books found');

  const matches: any[] = [];
  for (const book of targetBooks) {
    const vcards = await carddav.fetchVCards({ addressBook: book });
    for (const v of vcards || []) {
      if (matches.length >= limit) break;
      const summary = typeof v.data === 'string' ? parseVCardSummary(v.data) : undefined;
      const hay = JSON.stringify(summary || '').toLowerCase();
      if (hay.includes(q)) {
        matches.push({ id: v.url, url: v.url, etag: v.etag, summary });
      }
    }
    if (matches.length >= limit) break;
  }
  return matches;
}

/** List contacts from an address book. */
export async function listContacts(input: { addressBookId: string; limit?: number }) {
  const limit = input.limit ?? 50;
  const { carddav } = dav();
  await carddav.login();
  const books = await carddav.fetchAddressBooks();
  const book = (books || []).find((b: any) => b.url === input.addressBookId);
  if (!book) throw new Error('Address book not found');

  const vcards = await carddav.fetchVCards({ addressBook: book });
  const sliced = (vcards || []).slice(0, limit);
  return sliced.map((v: any) => ({
    id: v.url,
    url: v.url,
    etag: v.etag,
    summary: typeof v.data === 'string' ? parseVCardSummary(v.data) : undefined,
    vcard: v.data,
  }));
}

/** Get a single contact by its vCard URL. */
export async function getContact(contactId: string) {
  const { carddav } = dav();
  await carddav.login();
  const books = await carddav.fetchAddressBooks();
  const book = (books || []).find((b: any) => typeof b.url === 'string' && contactId.startsWith(b.url));
  if (!book) throw new Error('Address book for contact not found');

  const [v] = await carddav.fetchVCards({ addressBook: book, objectUrls: [contactId] });
  if (!v) throw new Error('Contact not found');
  return {
    id: v.url,
    url: v.url,
    etag: v.etag,
    summary: typeof v.data === 'string' ? parseVCardSummary(v.data) : undefined,
    vcard: v.data,
  };
}

/** Create a new contact. */
export async function createContact(input: {
  addressBookId: string;
  fullName: string;
  emails?: string[];
  phones?: string[];
  note?: string;
}) {
  const { carddav } = dav();
  await carddav.login();
  const books = await carddav.fetchAddressBooks();
  const book = (books || []).find((b: any) => b.url === input.addressBookId);
  if (!book) throw new Error('Address book not found');

  const { uid, vcard, filename } = buildVCard({
    fullName: input.fullName,
    emails: input.emails,
    phones: input.phones,
    note: input.note,
  });

  const res = await carddav.createVCard({ addressBook: book, vCardString: vcard, filename });
  if (!res.ok) throw new Error(`CardDAV create failed (${res.status})`);

  const contactUrl = new URL(filename, book.url).href;
  return { uid, contactId: contactUrl };
}

/** Update a contact. Provide a full vCard string. */
export async function updateContact(contactId: string, vCardString: string) {
  const { carddav } = dav();
  await carddav.login();
  const books = await carddav.fetchAddressBooks();
  const book = (books || []).find((b: any) => typeof b.url === 'string' && contactId.startsWith(b.url));
  if (!book) throw new Error('Address book for contact not found');

  const [existing] = await carddav.fetchVCards({ addressBook: book, objectUrls: [contactId], useMultiGet: true });
  if (!existing) throw new Error('Contact not found');

  const res = await carddav.updateVCard({
    vCard: { url: existing.url, etag: existing.etag, data: vCardString },
  });
  if (!res.ok) throw new Error(`CardDAV update failed (${res.status})`);
}

/** Delete a contact by its vCard URL. */
export async function deleteContact(contactId: string) {
  const { carddav } = dav();
  await carddav.login();
  const books = await carddav.fetchAddressBooks();
  const book = (books || []).find((b: any) => typeof b.url === 'string' && contactId.startsWith(b.url));
  if (!book) throw new Error('Address book for contact not found');

  const [existing] = await carddav.fetchVCards({ addressBook: book, objectUrls: [contactId], useMultiGet: true });
  if (!existing) throw new Error('Contact not found');

  const res = await carddav.deleteVCard({
    vCard: { url: existing.url, etag: existing.etag },
  });
  if (!res.ok) throw new Error(`CardDAV delete failed (${res.status})`);
}
