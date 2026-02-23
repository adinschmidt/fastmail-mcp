/**
 * Timezone utilities for CalDAV calendar operations.
 *
 * Resolves effective timezone from: calendar-level VTIMEZONE → machine default.
 * Normalizes naive (offset-less) datetimes into offset-aware ISO strings.
 */

/** Get the machine's IANA timezone identifier (e.g. "America/New_York"). */
export function getMachineTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Extract an IANA timezone ID from a CalDAV `calendar-timezone` property value.
 * The property is typically a VCALENDAR containing a VTIMEZONE component with a TZID.
 */
export function extractCalendarTimezone(vtimezone: string | undefined): string | undefined {
  if (!vtimezone) return undefined;
  const match = vtimezone.match(/TZID:([^\r\n]+)/);
  return match?.[1]?.trim() || undefined;
}

/** Resolve effective timezone: calendar timezone first, then machine fallback. */
export function resolveTimezone(calendarTimezone?: string): string {
  return calendarTimezone || getMachineTimezone();
}

/** Validate an IANA timezone identifier. */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Check whether an ISO datetime string already has a timezone offset (Z or ±HH:MM). */
export function hasTimezoneOffset(datetime: string): boolean {
  return /Z$|[+-]\d{2}:\d{2}$/.test(datetime);
}

/**
 * Convert a naive (no-offset) ISO datetime to a UTC ISO string,
 * interpreting the naive time as being in the given IANA timezone.
 *
 * E.g. naiveToUtcIso("2026-06-15T14:30:00", "America/New_York")
 *   → "2026-06-15T18:30:00.000Z"  (EDT = UTC-4)
 */
export function naiveToUtcIso(naive: string, tzId: string): string {
  const match = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid naive datetime (expected YYYY-MM-DDTHH:MM:SS): ${naive}`);

  const [, ys, mos, ds, hs, mis, ss] = match;
  const y = Number(ys), mo = Number(mos), d = Number(ds);
  const h = Number(hs), mi = Number(mis), s = Number(ss);

  // Treat the components as-if UTC to get a reference point.
  const asUtc = new Date(Date.UTC(y, mo - 1, d, h, mi, s));

  // Determine the UTC offset of the target timezone at this approximate instant.
  // We format the same UTC instant in both UTC and the target tz, then diff.
  const utcRepr = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzRepr = new Date(asUtc.toLocaleString('en-US', { timeZone: tzId }));
  const offsetMs = tzRepr.getTime() - utcRepr.getTime();

  // The real UTC time = asUtc shifted back by the offset.
  return new Date(asUtc.getTime() - offsetMs).toISOString();
}

/**
 * Ensure a datetime string is offset-aware. If it already has an offset, return as-is.
 * If naive, interpret it in the given timezone and return a UTC ISO string.
 */
export function ensureOffsetAware(datetime: string, tzId: string): string {
  if (hasTimezoneOffset(datetime)) return datetime;
  return naiveToUtcIso(datetime, tzId);
}

/**
 * Build a minimal VCALENDAR with VTIMEZONE for the CalDAV `calendar-timezone` property.
 * Uses the IANA TZID; most CalDAV servers look up the real rules from the ID.
 */
export function buildCalendarTimezoneProperty(tzId: string): string {
  // Compute current standard offset for the timezone to populate the required STANDARD component.
  // Use January 1 of a reference year (non-DST for most northern-hemisphere zones).
  const jan = new Date(Date.UTC(2020, 0, 1, 12, 0, 0));
  const utcRepr = new Date(jan.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzRepr = new Date(jan.toLocaleString('en-US', { timeZone: tzId }));
  const offsetMin = (tzRepr.getTime() - utcRepr.getTime()) / 60_000;

  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  const offsetStr = `${sign}${hh}${mm}`;

  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//fastmail-mcp//EN',
    'VERSION:2.0',
    'BEGIN:VTIMEZONE',
    `TZID:${tzId}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${offsetStr}`,
    `TZOFFSETTO:${offsetStr}`,
    'END:STANDARD',
    'END:VTIMEZONE',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}
