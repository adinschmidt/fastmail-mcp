export type FastmailAuthConfig =
  | {
      kind: 'basic';
      username: string;
      appPassword: string;
      baseUrl: string;
    }
  | {
      kind: 'bearer';
      apiToken: string;
      baseUrl: string;
    };

export type DavConfig = {
  username: string;
  appPassword: string;
  caldavUrl: string;
  carddavUrl: string;
};

function normalizeUrl(input: string, defaultUrl: string): string {
  const raw = (input || '').trim();
  const base = raw.length > 0 ? raw : defaultUrl;
  const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(base) ? base : `https://${base}`;
  return withProto.replace(/\/+$/, '');
}

function env(name: string): string | undefined {
  const v = process.env[name];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  // Guard against clients that pass placeholders like "${VAR}"
  if (/\$\{[^}]+\}/.test(t)) return undefined;
  return t;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export function loadFastmailAuthConfig(): FastmailAuthConfig {
  const baseUrl = normalizeUrl(env('FASTMAIL_BASE_URL') || '', 'https://api.fastmail.com');

  const apiToken = env('FASTMAIL_API_TOKEN');
  if (apiToken) {
    return { kind: 'bearer', apiToken, baseUrl };
  }

  const username = env('FASTMAIL_USERNAME');
  const appPassword = env('FASTMAIL_APP_PASSWORD');
  if (!username || !appPassword) {
    throw new Error(
      'Missing credentials. Provide FASTMAIL_USERNAME + FASTMAIL_APP_PASSWORD (recommended) or FASTMAIL_API_TOKEN.'
    );
  }

  return { kind: 'basic', username, appPassword, baseUrl };
}

export function loadDavConfig(): DavConfig {
  const username = env('FASTMAIL_DAV_USERNAME') || env('FASTMAIL_USERNAME');
  const appPassword = env('FASTMAIL_APP_PASSWORD');
  if (!username || !appPassword) {
    throw new Error('Missing DAV credentials. Provide FASTMAIL_USERNAME + FASTMAIL_APP_PASSWORD.');
  }

  // Fastmail CalDAV/CardDAV endpoints work reliably using the principal URL.
  const caldavBase = normalizeUrl(env('FASTMAIL_CALDAV_URL') || '', 'https://caldav.fastmail.com');
  const carddavBase = normalizeUrl(env('FASTMAIL_CARDDAV_URL') || '', 'https://carddav.fastmail.com');

  const principalUser = encodeURIComponent(username);
  const caldavUrl = ensureTrailingSlash(
    caldavBase.includes('/dav/') ? caldavBase : `${caldavBase}/dav/principals/user/${principalUser}`
  );
  const carddavUrl = ensureTrailingSlash(
    carddavBase.includes('/dav/') ? carddavBase : `${carddavBase}/dav/principals/user/${principalUser}`
  );

  return { username, appPassword, caldavUrl, carddavUrl };
}
