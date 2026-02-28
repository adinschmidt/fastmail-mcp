import { describe, test, expect, mock, beforeEach } from 'bun:test';

/**
 * Unit tests for the create_calendar, update_calendar, and delete_calendar
 * MCP tools. We mock the DAV client to verify the correct CalDAV payloads
 * (namespace prefixes, method, body structure) and error handling.
 */

// ---------------------------------------------------------------------------
// Helpers – extract the tool handler logic so we can test without spinning up
// a full MCP server. We replicate the minimal logic from index.ts.
// ---------------------------------------------------------------------------

type MockCaldav = {
  login: ReturnType<typeof mock>;
  account: { homeUrl?: string } | undefined;
  makeCalendar: ReturnType<typeof mock>;
  fetchCalendars: ReturnType<typeof mock>;
  davRequest: ReturnType<typeof mock>;
  deleteObject: ReturnType<typeof mock>;
  propfind: ReturnType<typeof mock>;
};

function createMockCaldav(overrides: Partial<MockCaldav> = {}): MockCaldav {
  return {
    login: mock(() => Promise.resolve()),
    account: { homeUrl: 'https://caldav.fastmail.com/dav/calendars/user/test@fastmail.com/' },
    makeCalendar: mock(() => Promise.resolve([])),
    fetchCalendars: mock(() =>
      Promise.resolve([
        { url: 'https://caldav.fastmail.com/dav/calendars/user/test@fastmail.com/default/', displayName: 'Default' },
        { url: 'https://caldav.fastmail.com/dav/calendars/user/test@fastmail.com/work/', displayName: 'Work' },
      ])
    ),
    davRequest: mock(() => Promise.resolve([])),
    deleteObject: mock(() => Promise.resolve(new Response('', { status: 204 }))),
    propfind: mock(() => Promise.resolve([])),
    ...overrides,
  };
}

// Replicate getCalendarRights helper (mirrors index.ts logic)
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

function computeDavRights(privileges: string[]) {
  const canRead = privileges.includes('read') || privileges.includes('all');
  const canWrite =
    privileges.includes('write') ||
    privileges.includes('writeContent') ||
    privileges.includes('writeProperties') ||
    privileges.includes('all');
  return { privileges, canRead, canWrite };
}

async function getCalendarRights(caldav: MockCaldav, calendarUrl: string) {
  try {
    const res = await caldav.propfind({
      url: calendarUrl,
      depth: '0',
      props: { 'current-user-privilege-set': {} },
    });
    const props = (res as any)?.[0]?.props as any;
    const privileges = extractDavPrivileges(props?.currentUserPrivilegeSet);
    if (!privileges.length) return null;
    return computeDavRights(privileges);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool handler replicas (same logic as index.ts but accepting a mock caldav)
// ---------------------------------------------------------------------------

async function handleCreateCalendar(
  caldav: MockCaldav,
  params: { name: string; description?: string; color?: string }
) {
  const { name, description, color } = params;
  await caldav.login();
  const homeUrl = caldav.account?.homeUrl;
  if (!homeUrl) throw new Error('Could not determine calendar home URL');

  const id = crypto.randomUUID();
  const url = `${homeUrl}${id}/`;

  const props: Record<string, any> = { displayname: name };
  if (description) props['c:calendar-description'] = description;
  if (color) props['ca:calendar-color'] = color;

  await caldav.makeCalendar({ url, props });
  return { calendarId: url, name };
}

async function handleUpdateCalendar(
  caldav: MockCaldav,
  params: { calendarId: string; name?: string; description?: string; color?: string }
) {
  const { calendarId, name, description, color } = params;
  if (name === undefined && description === undefined && color === undefined) {
    throw new Error('At least one property (name, description, color) must be provided');
  }

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

  await caldav.davRequest({
    url: calendarId,
    init: {
      method: 'PROPPATCH',
      namespace: 'd',
      body: { propertyupdate: { set: { prop: setProps } } },
      attributes: {
        'xmlns:d': 'DAV:',
        'xmlns:c': 'urn:ietf:params:xml:ns:caldav',
        'xmlns:ca': 'http://apple.com/ns/ical/',
      },
    },
  });

  return 'OK';
}

async function handleDeleteCalendar(caldav: MockCaldav, params: { calendarId: string }) {
  const { calendarId } = params;
  await caldav.login();

  const calendars = await caldav.fetchCalendars();
  const calendar = (calendars || []).find((c: any) => c.url === calendarId);
  if (!calendar) throw new Error('Calendar not found');

  if ((calendars || []).length <= 1) {
    throw new Error('Refusing to delete the last remaining calendar.');
  }

  await caldav.deleteObject({ url: calendarId });
  return 'OK';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create_calendar', () => {
  test('calls makeCalendar with correct URL and displayname', async () => {
    const caldav = createMockCaldav();
    const result = await handleCreateCalendar(caldav, { name: 'My Calendar' });

    expect(caldav.login).toHaveBeenCalledTimes(1);
    expect(caldav.makeCalendar).toHaveBeenCalledTimes(1);

    const call = (caldav.makeCalendar as any).mock.calls[0][0];
    expect(call.url).toStartWith('https://caldav.fastmail.com/dav/calendars/user/test@fastmail.com/');
    expect(call.url).toEndWith('/');
    expect(call.props.displayname).toBe('My Calendar');
    expect(result.name).toBe('My Calendar');
  });

  test('includes c:calendar-description when description provided', async () => {
    const caldav = createMockCaldav();
    await handleCreateCalendar(caldav, { name: 'Test', description: 'A test calendar' });

    const call = (caldav.makeCalendar as any).mock.calls[0][0];
    expect(call.props['c:calendar-description']).toBe('A test calendar');
    // Must NOT use uppercase C: prefix
    expect(call.props['C:calendar-description']).toBeUndefined();
  });

  test('includes ca:calendar-color when color provided', async () => {
    const caldav = createMockCaldav();
    await handleCreateCalendar(caldav, { name: 'Test', color: '#FF0000' });

    const call = (caldav.makeCalendar as any).mock.calls[0][0];
    expect(call.props['ca:calendar-color']).toBe('#FF0000');
    // Must NOT use I: prefix (Apple namespace is ca: in tsdav)
    expect(call.props['I:calendar-color']).toBeUndefined();
  });

  test('throws when homeUrl is missing', async () => {
    const caldav = createMockCaldav({ account: undefined });
    await expect(handleCreateCalendar(caldav, { name: 'Test' })).rejects.toThrow(
      'Could not determine calendar home URL'
    );
  });

  test('generates unique UUID-based URLs', async () => {
    const caldav = createMockCaldav();
    await handleCreateCalendar(caldav, { name: 'A' });
    await handleCreateCalendar(caldav, { name: 'B' });

    const url1 = (caldav.makeCalendar as any).mock.calls[0][0].url;
    const url2 = (caldav.makeCalendar as any).mock.calls[1][0].url;
    expect(url1).not.toBe(url2);
  });
});

describe('update_calendar', () => {
  const calUrl = 'https://caldav.fastmail.com/dav/calendars/user/test@fastmail.com/default/';

  test('sends PROPPATCH with correct namespace declarations', async () => {
    const caldav = createMockCaldav();
    await handleUpdateCalendar(caldav, { calendarId: calUrl, name: 'Renamed' });

    expect(caldav.davRequest).toHaveBeenCalledTimes(1);
    const call = (caldav.davRequest as any).mock.calls[0][0];

    expect(call.url).toBe(calUrl);
    expect(call.init.method).toBe('PROPPATCH');
    expect(call.init.namespace).toBe('d');
    expect(call.init.attributes).toEqual({
      'xmlns:d': 'DAV:',
      'xmlns:c': 'urn:ietf:params:xml:ns:caldav',
      'xmlns:ca': 'http://apple.com/ns/ical/',
    });
  });

  test('uses correct namespace prefixes in property keys', async () => {
    const caldav = createMockCaldav();
    await handleUpdateCalendar(caldav, {
      calendarId: calUrl,
      name: 'New Name',
      description: 'New Desc',
      color: '#00FF00',
    });

    const call = (caldav.davRequest as any).mock.calls[0][0];
    const setProps = call.init.body.propertyupdate.set.prop;

    expect(setProps['displayname']).toBe('New Name');
    expect(setProps['c:calendar-description']).toBe('New Desc');
    expect(setProps['ca:calendar-color']).toBe('#00FF00');
    // Must NOT use uppercase prefixes
    expect(setProps['C:calendar-description']).toBeUndefined();
    expect(setProps['I:calendar-color']).toBeUndefined();
  });

  test('only includes provided properties', async () => {
    const caldav = createMockCaldav();
    await handleUpdateCalendar(caldav, { calendarId: calUrl, color: '#0000FF' });

    const call = (caldav.davRequest as any).mock.calls[0][0];
    const setProps = call.init.body.propertyupdate.set.prop;

    expect(Object.keys(setProps)).toEqual(['ca:calendar-color']);
    expect(setProps['ca:calendar-color']).toBe('#0000FF');
  });

  test('throws when no properties provided', async () => {
    const caldav = createMockCaldav();
    await expect(
      handleUpdateCalendar(caldav, { calendarId: calUrl })
    ).rejects.toThrow('At least one property');
  });

  test('throws when calendar not found', async () => {
    const caldav = createMockCaldav();
    await expect(
      handleUpdateCalendar(caldav, {
        calendarId: 'https://caldav.fastmail.com/dav/calendars/user/test@fastmail.com/nonexistent/',
        name: 'X',
      })
    ).rejects.toThrow('Calendar not found');
  });

  test('throws when calendar is read-only', async () => {
    const caldav = createMockCaldav({
      propfind: mock(() =>
        Promise.resolve([
          { props: { currentUserPrivilegeSet: { privilege: [{ read: {} }] } } },
        ])
      ),
    });

    await expect(
      handleUpdateCalendar(caldav, { calendarId: calUrl, name: 'X' })
    ).rejects.toThrow('read-only');
  });
});

describe('delete_calendar', () => {
  const calUrl = 'https://caldav.fastmail.com/dav/calendars/user/test@fastmail.com/work/';

  test('deletes calendar when multiple calendars exist', async () => {
    const caldav = createMockCaldav();
    const result = await handleDeleteCalendar(caldav, { calendarId: calUrl });

    expect(result).toBe('OK');
    expect(caldav.deleteObject).toHaveBeenCalledTimes(1);
    expect((caldav.deleteObject as any).mock.calls[0][0]).toEqual({ url: calUrl });
  });

  test('refuses to delete the last remaining calendar', async () => {
    const caldav = createMockCaldav({
      fetchCalendars: mock(() =>
        Promise.resolve([
          { url: 'https://caldav.fastmail.com/dav/calendars/user/test@fastmail.com/only/', displayName: 'Only' },
        ])
      ),
    });

    await expect(
      handleDeleteCalendar(caldav, {
        calendarId: 'https://caldav.fastmail.com/dav/calendars/user/test@fastmail.com/only/',
      })
    ).rejects.toThrow('last remaining calendar');
    expect(caldav.deleteObject).not.toHaveBeenCalled();
  });

  test('throws when calendar not found', async () => {
    const caldav = createMockCaldav();
    await expect(
      handleDeleteCalendar(caldav, {
        calendarId: 'https://caldav.fastmail.com/dav/calendars/user/test@fastmail.com/nonexistent/',
      })
    ).rejects.toThrow('Calendar not found');
    expect(caldav.deleteObject).not.toHaveBeenCalled();
  });
});
