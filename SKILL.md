# JMAP/DAV SDK

TypeScript SDK for mail (JMAP), calendar (CalDAV), and contacts (CardDAV). Provider-generic; Fastmail works out of the box. The examples below use `fastmail` as the import alias — any name works.

**Import:**

```typescript
import * as fastmail from './jmap-dav-mcp/src/sdk.js';
```

**Required env vars:**

- Fastmail: `FASTMAIL_USERNAME` + `FASTMAIL_APP_PASSWORD` (or `FASTMAIL_API_TOKEN` alone for mail). Server URLs are implied.
- Other providers: `JMAP_BASE_URL` + `JMAP_API_TOKEN` (or `JMAP_USERNAME`/`JMAP_PASSWORD`) for mail; `CALDAV_URL`/`CARDDAV_URL` + `DAV_USERNAME`/`DAV_PASSWORD` for calendar/contacts.
- Calendar event creation also needs `DAV_ORGANIZER_EMAIL` (falls back to `DAV_USERNAME`/`FASTMAIL_USERNAME`).

---

## Mail

### listMailboxes

Returns all mailboxes. Call this first — most mail functions need a mailbox ID.

```typescript
const mailboxes = await fastmail.listMailboxes();
// Each has: id, name, role ("inbox", "sent", "drafts", "trash", …)
```

### listEmails

```typescript
const emails = await fastmail.listEmails({ mailboxId: 'P-F', limit: 20 });
// mailboxId is optional — omit to list from all mailboxes
// Each has: id, subject, from, to, receivedAt, preview, hasAttachment, keywords, threadId
```

### getEmail

```typescript
const email = await fastmail.getEmail('M1234abc');
// Full email with textBody, htmlBody, bodyValues, attachments
```

### searchEmails

```typescript
const results = await fastmail.searchEmails({ query: 'invoice', limit: 10 });
```

### sendEmail

```typescript
const { submissionId, emailId } = await fastmail.sendEmail({
  to: ['alice@example.com'],
  subject: 'Hello',
  textBody: 'Hi Alice!',
  // Optional: cc, bcc, from, htmlBody
});
```

### markEmailRead

```typescript
await fastmail.markEmailRead('M1234abc', true);   // mark read
await fastmail.markEmailRead('M1234abc', false);  // mark unread
```

### moveEmail

```typescript
await fastmail.moveEmail('M1234abc', targetMailboxId);
```

### deleteEmail

Moves to Trash.

```typescript
await fastmail.deleteEmail('M1234abc');
```

### getEmailAttachments

```typescript
const attachments = await fastmail.getEmailAttachments('M1234abc');
// Each has: partId, blobId, type, size, name
```

### getAttachmentDownloadUrl

```typescript
const url = await fastmail.getAttachmentDownloadUrl('M1234abc', 'blobId_or_partId');
```

### createMailbox / updateMailbox / deleteMailbox

```typescript
const created = await fastmail.createMailbox({ name: 'Receipts', parentId: 'P-F' });
await fastmail.updateMailbox('Mbox123', { name: 'Old Receipts' });
await fastmail.deleteMailbox('Mbox123'); // refuses protected system mailboxes
```

---

## Calendar

### listCalendars

Returns all calendars with permissions. Call this first — calendar functions need a calendar ID (which is a URL).

```typescript
const calendars = await fastmail.listCalendars();
// Each has: id, name, url, timezone, canWrite, privileges
```

### listCalendarEvents

```typescript
const events = await fastmail.listCalendarEvents({
  calendarId: 'https://caldav.fastmail.com/dav/…/cal-uuid/',
  timeRangeStart: '2026-04-01T00:00:00',  // ISO 8601, offset optional
  timeRangeEnd: '2026-04-30T23:59:59',
  limit: 100,
});
// Each has: id, url, etag, summary (parsed), ical (raw)
// summary: { uid, title, start, end, location }
```

Naive datetimes (no offset) are interpreted in the calendar's timezone, or the machine default.

### getCalendarEvent

```typescript
const event = await fastmail.getCalendarEvent('https://caldav.fastmail.com/…/event.ics');
```

### createCalendarEvent

```typescript
const { uid, eventId } = await fastmail.createCalendarEvent({
  calendarId: 'https://caldav.fastmail.com/dav/…/cal-uuid/',
  title: 'Team standup',
  start: '2026-04-10T09:00:00-04:00',
  end: '2026-04-10T09:30:00-04:00',
  location: 'Conference room B',
  description: 'Weekly sync',
  attendees: [{ email: 'alice@example.com', name: 'Alice' }],
});
```

### updateCalendarEvent

Requires a full iCalendar string. Fetch the event first, modify the iCal, then pass it back.

```typescript
const event = await fastmail.getCalendarEvent(eventId);
const modifiedIcal = event.ical.replace('SUMMARY:Old Title', 'SUMMARY:New Title');
await fastmail.updateCalendarEvent(eventId, modifiedIcal);
```

### deleteCalendarEvent

```typescript
await fastmail.deleteCalendarEvent(eventId);
```

### createCalendar / updateCalendar / deleteCalendar

```typescript
const { calendarId } = await fastmail.createCalendar({
  name: 'Work',
  timezone: 'America/New_York',
  color: '#3366CC',
});
await fastmail.updateCalendar({ calendarId, name: 'Work (archived)' });
await fastmail.deleteCalendar(calendarId); // refuses to delete last remaining calendar
```

---

## Contacts

### listContactLists

Returns address books. Call this first — contact functions need an address book ID (which is a URL).

```typescript
const books = await fastmail.listContactLists();
// Each has: id, name, url
```

### listContacts

```typescript
const contacts = await fastmail.listContacts({
  addressBookId: 'https://carddav.fastmail.com/dav/…/book-uuid/',
  limit: 50,
});
// Each has: id, url, etag, summary (parsed), vcard (raw)
// summary: { uid, fullName, emails, phones }
```

### searchContacts

Client-side substring match across all fields.

```typescript
const matches = await fastmail.searchContacts({ query: 'alice', limit: 10 });
```

### getContact

```typescript
const contact = await fastmail.getContact('https://carddav.fastmail.com/…/contact.vcf');
```

### createContact

```typescript
const { uid, contactId } = await fastmail.createContact({
  addressBookId: 'https://carddav.fastmail.com/dav/…/book-uuid/',
  fullName: 'Alice Smith',
  emails: ['alice@example.com'],
  phones: ['+1-555-0123'],
  note: 'Met at conference',
});
```

### updateContact

Requires a full vCard string. Fetch first, modify, pass back.

```typescript
const contact = await fastmail.getContact(contactId);
const modifiedVcard = contact.vcard.replace('FN:Alice Smith', 'FN:Alice Jones');
await fastmail.updateContact(contactId, modifiedVcard);
```

### deleteContact

```typescript
await fastmail.deleteContact(contactId);
```

---

## Common Patterns

**Filtering results in code (not round-tripping through the model):**

```typescript
const emails = await fastmail.listEmails({ limit: 100 });
const unread = emails.filter(e => !e.keywords?.$seen);
const fromAlice = unread.filter(e => e.from?.some(f => f.email?.includes('alice')));
console.log(`${fromAlice.length} unread emails from Alice`);
```

**Composing across domains:**

```typescript
const events = await fastmail.listCalendarEvents({
  calendarId,
  timeRangeStart: '2026-04-07T00:00:00',
  timeRangeEnd: '2026-04-08T00:00:00',
});
for (const event of events) {
  if (!event.summary?.title) continue;
  const contacts = await fastmail.searchContacts({ query: event.summary.title });
  console.log(`${event.summary.title}: ${contacts.length} matching contacts`);
}
```

**Persisting intermediate data:**

```typescript
import { writeFile } from 'node:fs/promises';

const contacts = await fastmail.listContacts({ addressBookId, limit: 500 });
const csv = contacts
  .map(c => `${c.summary?.fullName},${c.summary?.emails.join(';')}`)
  .join('\n');
await writeFile('./contacts.csv', csv);
console.log(`Exported ${contacts.length} contacts to contacts.csv`);
```
