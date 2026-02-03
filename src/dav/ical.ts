import { randomUUID } from 'node:crypto';

export type CreateEventInput = {
  title: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  description?: string;
  location?: string;
  organizerEmail: string;
  organizerName?: string;
  attendees?: Array<{ email: string; name?: string }>;
};

function toIcsDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO datetime: ${iso}`);
  }
  // UTC format: YYYYMMDDTHHMMSSZ
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function foldLine(line: string): string {
  // iCalendar line folding at 75 octets is spec-y; we do a simple char-based fold.
  const max = 72;
  if (line.length <= max) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > max) {
    parts.push(rest.slice(0, max));
    rest = ' ' + rest.slice(max);
  }
  parts.push(rest);
  return parts.join('\r\n');
}

function escText(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

export function buildIcsEvent(input: CreateEventInput): { uid: string; ics: string; filename: string } {
  const uid = randomUUID();
  const dtstamp = toIcsDateTime(new Date().toISOString());
  const dtstart = toIcsDateTime(input.start);
  const dtend = toIcsDateTime(input.end);

  const lines: string[] = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//fastmail-mcp//EN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${dtstamp}`);
  lines.push(`DTSTART:${dtstart}`);
  lines.push(`DTEND:${dtend}`);

  // Fastmail CalDAV enforces scheduling/iTIP restrictions and requires ORGANIZER.
  const organizerCn = input.organizerName ? `;CN=${escText(input.organizerName)}` : '';
  lines.push(foldLine(`ORGANIZER${organizerCn}:mailto:${input.organizerEmail}`));

  lines.push(foldLine(`SUMMARY:${escText(input.title)}`));
  if (input.description) lines.push(foldLine(`DESCRIPTION:${escText(input.description)}`));
  if (input.location) lines.push(foldLine(`LOCATION:${escText(input.location)}`));
  if (input.attendees?.length) {
    for (const a of input.attendees) {
      const cn = a.name ? `;CN=${escText(a.name)}` : '';
      lines.push(foldLine(`ATTENDEE${cn}:mailto:${a.email}`));
    }
  }
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  const ics = lines.join('\r\n') + '\r\n';
  const filename = `${uid}.ics`;
  return { uid, ics, filename };
}

export function parseIcsSummary(ics: string): { uid?: string; title?: string; start?: string; end?: string; location?: string } {
  // Minimal, best-effort parser (handles folded lines).
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const get = (key: string): string | undefined => {
    const m = unfolded.match(new RegExp(`\\n${key}[^:]*:(.*)`));
    return m?.[1]?.trim();
  };
  return {
    uid: get('UID'),
    title: get('SUMMARY'),
    start: get('DTSTART'),
    end: get('DTEND'),
    location: get('LOCATION'),
  };
}
