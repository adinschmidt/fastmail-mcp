import { describe, test, expect } from 'bun:test';
import {
  getMachineTimezone,
  extractCalendarTimezone,
  resolveTimezone,
  isValidTimezone,
  hasTimezoneOffset,
  naiveToUtcIso,
  ensureOffsetAware,
  buildCalendarTimezoneProperty,
} from './timezone';

describe('getMachineTimezone', () => {
  test('returns a non-empty valid IANA timezone string', () => {
    const tz = getMachineTimezone();
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
    expect(isValidTimezone(tz)).toBe(true);
  });
});

describe('extractCalendarTimezone', () => {
  test('extracts TZID from a VTIMEZONE blob', () => {
    const blob = [
      'BEGIN:VCALENDAR',
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:STANDARD',
      'DTSTART:19701101T020000',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'END:VTIMEZONE',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(extractCalendarTimezone(blob)).toBe('America/New_York');
  });

  test('returns undefined for undefined input', () => {
    expect(extractCalendarTimezone(undefined)).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(extractCalendarTimezone('')).toBeUndefined();
  });

  test('returns undefined when no TZID present', () => {
    expect(extractCalendarTimezone('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toBeUndefined();
  });
});

describe('resolveTimezone', () => {
  test('returns calendar timezone when provided', () => {
    expect(resolveTimezone('Europe/London')).toBe('Europe/London');
  });

  test('falls back to machine timezone when undefined', () => {
    const result = resolveTimezone(undefined);
    expect(result).toBe(getMachineTimezone());
  });

  test('falls back to machine timezone for empty string', () => {
    const result = resolveTimezone('');
    expect(result).toBe(getMachineTimezone());
  });
});

describe('isValidTimezone', () => {
  test('accepts valid IANA timezones', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  test('rejects invalid timezones', () => {
    expect(isValidTimezone('Not/A/Timezone')).toBe(false);
    expect(isValidTimezone('foo')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('hasTimezoneOffset', () => {
  test('detects Z suffix', () => {
    expect(hasTimezoneOffset('2026-02-23T15:00:00Z')).toBe(true);
  });

  test('detects positive offset', () => {
    expect(hasTimezoneOffset('2026-02-23T15:00:00+05:30')).toBe(true);
  });

  test('detects negative offset', () => {
    expect(hasTimezoneOffset('2026-02-23T15:00:00-04:00')).toBe(true);
  });

  test('returns false for naive datetime', () => {
    expect(hasTimezoneOffset('2026-02-23T15:00:00')).toBe(false);
  });
});

describe('naiveToUtcIso', () => {
  test('converts EST (UTC-5) naive datetime to UTC', () => {
    // Jan 15 in EST is UTC-5 (standard time)
    const result = naiveToUtcIso('2026-01-15T14:30:00', 'America/New_York');
    expect(result).toBe('2026-01-15T19:30:00.000Z');
  });

  test('converts EDT (UTC-4) naive datetime to UTC', () => {
    // Jun 15 in EDT is UTC-4 (daylight saving)
    const result = naiveToUtcIso('2026-06-15T14:30:00', 'America/New_York');
    expect(result).toBe('2026-06-15T18:30:00.000Z');
  });

  test('converts UTC naive datetime unchanged', () => {
    const result = naiveToUtcIso('2026-03-01T12:00:00', 'UTC');
    expect(result).toBe('2026-03-01T12:00:00.000Z');
  });

  test('handles positive-offset timezone (Asia/Tokyo, UTC+9)', () => {
    const result = naiveToUtcIso('2026-03-01T09:00:00', 'Asia/Tokyo');
    expect(result).toBe('2026-03-01T00:00:00.000Z');
  });

  test('handles half-hour offset (Asia/Kolkata, UTC+5:30)', () => {
    const result = naiveToUtcIso('2026-03-01T15:30:00', 'Asia/Kolkata');
    expect(result).toBe('2026-03-01T10:00:00.000Z');
  });

  test('handles DST spring-forward correctly (Mar 8 2026, America/New_York)', () => {
    // Clocks spring forward at 2:00 AM EST → 3:00 AM EDT on Mar 8, 2026.
    // 03:30 local exists only as EDT (UTC-4), so correct UTC is 07:30.
    const result = naiveToUtcIso('2026-03-08T03:30:00', 'America/New_York');
    expect(result).toBe('2026-03-08T07:30:00.000Z');
  });

  test('handles DST fall-back correctly (Nov 1 2026, America/New_York)', () => {
    // Clocks fall back at 2:00 AM EDT → 1:00 AM EST on Nov 1, 2026.
    // 01:30 is ambiguous; we accept either EDT (05:30Z) or EST (06:30Z).
    const result = naiveToUtcIso('2026-11-01T01:30:00', 'America/New_York');
    const utcHour = new Date(result).getUTCHours();
    expect(utcHour === 5 || utcHour === 6).toBe(true);
  });

  test('throws for invalid datetime format', () => {
    expect(() => naiveToUtcIso('not-a-date', 'UTC')).toThrow('Invalid naive datetime');
    expect(() => naiveToUtcIso('2026-02-23', 'UTC')).toThrow('Invalid naive datetime');
    expect(() => naiveToUtcIso('2026-02-23T15:00:00Z', 'UTC')).toThrow('Invalid naive datetime');
  });
});

describe('ensureOffsetAware', () => {
  test('returns offset-aware string as-is', () => {
    expect(ensureOffsetAware('2026-02-23T15:00:00Z', 'America/New_York')).toBe('2026-02-23T15:00:00Z');
    expect(ensureOffsetAware('2026-02-23T15:00:00+05:00', 'UTC')).toBe('2026-02-23T15:00:00+05:00');
  });

  test('converts naive datetime using given timezone', () => {
    const result = ensureOffsetAware('2026-01-15T14:30:00', 'America/New_York');
    expect(result).toBe('2026-01-15T19:30:00.000Z');
  });
});

describe('buildCalendarTimezoneProperty', () => {
  test('generates valid VCALENDAR with VTIMEZONE', () => {
    const result = buildCalendarTimezoneProperty('America/New_York');
    expect(result).toContain('BEGIN:VCALENDAR');
    expect(result).toContain('END:VCALENDAR');
    expect(result).toContain('BEGIN:VTIMEZONE');
    expect(result).toContain('TZID:America/New_York');
    expect(result).toContain('BEGIN:STANDARD');
    expect(result).toContain('END:STANDARD');
    expect(result).toContain('END:VTIMEZONE');
  });

  test('generates valid offset format for UTC', () => {
    const result = buildCalendarTimezoneProperty('UTC');
    expect(result).toContain('TZID:UTC');
    expect(result).toContain('TZOFFSETFROM:+0000');
    expect(result).toContain('TZOFFSETTO:+0000');
  });

  test('roundtrips through extractCalendarTimezone', () => {
    const built = buildCalendarTimezoneProperty('Europe/London');
    const extracted = extractCalendarTimezone(built);
    expect(extracted).toBe('Europe/London');
  });
});
