export type JmapAuthConfig =
  | {
      kind: 'basic';
      username: string;
      password: string;
      sessionUrl: string;
    }
  | {
      kind: 'bearer';
      apiToken: string;
      sessionUrl: string;
    };

export type DavConfig = {
  username: string;
  password: string;
  caldavUrl: string;
  carddavUrl: string;
};

const FASTMAIL_JMAP_BASE = 'https://api.fastmail.com';
const FASTMAIL_CALDAV_BASE = 'https://caldav.fastmail.com';
const FASTMAIL_CARDDAV_BASE = 'https://carddav.fastmail.com';

function normalizeUrl(input: string): string {
  const raw = input.trim();
  const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
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

/** First non-empty value among the given env var names. */
function envAny(...names: string[]): string | undefined {
  for (const name of names) {
    const v = env(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** True when the credential env vars in use are the legacy FASTMAIL_* ones. */
function usingFastmailCredentials(): boolean {
  return Boolean(
    env('FASTMAIL_API_TOKEN') ||
      env('FASTMAIL_USERNAME') ||
      env('FASTMAIL_APP_PASSWORD') ||
      env('FASTMAIL_DAV_USERNAME')
  );
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export function loadJmapAuthConfig(): JmapAuthConfig {
  const explicitSessionUrl = env('JMAP_SESSION_URL');
  const baseUrlRaw = envAny('JMAP_BASE_URL', 'FASTMAIL_BASE_URL');

  const apiToken = envAny('JMAP_API_TOKEN', 'FASTMAIL_API_TOKEN');
  const username = envAny('JMAP_USERNAME', 'FASTMAIL_USERNAME');
  const password = envAny('JMAP_PASSWORD', 'FASTMAIL_APP_PASSWORD');

  let sessionUrl: string;
  if (explicitSessionUrl) {
    sessionUrl = normalizeUrl(explicitSessionUrl);
  } else {
    const baseUrl = baseUrlRaw
      ? normalizeUrl(baseUrlRaw)
      : usingFastmailCredentials()
        ? FASTMAIL_JMAP_BASE
        : undefined;
    if (!baseUrl) {
      throw new Error(
        'Missing JMAP server URL. Set JMAP_BASE_URL (session discovered at <base>/.well-known/jmap) or JMAP_SESSION_URL.'
      );
    }
    // RFC 8620 autodiscovery. Servers may redirect (Fastmail 302s to /jmap/session).
    sessionUrl = `${baseUrl}/.well-known/jmap`;
  }

  if (apiToken) {
    return { kind: 'bearer', apiToken, sessionUrl };
  }

  if (!username || !password) {
    throw new Error(
      'Missing JMAP credentials. Provide JMAP_USERNAME + JMAP_PASSWORD, or JMAP_API_TOKEN. (Legacy FASTMAIL_* equivalents are also accepted.)'
    );
  }

  return { kind: 'basic', username, password, sessionUrl };
}

export function loadDavConfig(): DavConfig {
  const username = envAny('DAV_USERNAME', 'FASTMAIL_DAV_USERNAME', 'FASTMAIL_USERNAME');
  const password = envAny('DAV_PASSWORD', 'FASTMAIL_APP_PASSWORD');
  if (!username || !password) {
    throw new Error(
      'Missing DAV credentials. Provide DAV_USERNAME + DAV_PASSWORD. (Legacy FASTMAIL_USERNAME + FASTMAIL_APP_PASSWORD are also accepted.)'
    );
  }

  const caldavRaw = envAny('CALDAV_URL', 'FASTMAIL_CALDAV_URL');
  const carddavRaw = envAny('CARDDAV_URL', 'FASTMAIL_CARDDAV_URL');
  const isFastmail = usingFastmailCredentials();
  if ((!caldavRaw || !carddavRaw) && !isFastmail) {
    throw new Error(
      'Missing DAV server URLs. Set CALDAV_URL and CARDDAV_URL (tsdav discovers collections from the server root).'
    );
  }

  const caldavBase = normalizeUrl(caldavRaw || FASTMAIL_CALDAV_BASE);
  const carddavBase = normalizeUrl(carddavRaw || FASTMAIL_CARDDAV_BASE);

  return {
    username,
    password,
    caldavUrl: withFastmailPrincipalPath(caldavBase, username),
    carddavUrl: withFastmailPrincipalPath(carddavBase, username),
  };
}

/**
 * Fastmail's DAV endpoints work most reliably when pointed at the principal
 * URL. For any other host, leave the URL untouched — tsdav discovers
 * collections from the server root.
 */
function withFastmailPrincipalPath(baseUrl: string, username: string): string {
  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
  if (!/(^|\.)fastmail\.com$/.test(host) || baseUrl.includes('/dav/')) {
    return ensureTrailingSlash(baseUrl);
  }
  return ensureTrailingSlash(`${baseUrl}/dav/principals/user/${encodeURIComponent(username)}`);
}

/** Organizer email used in generated iCalendar events. */
export function getOrganizerEmail(): string | undefined {
  return envAny(
    'DAV_ORGANIZER_EMAIL',
    'FASTMAIL_ORGANIZER_EMAIL',
    'DAV_USERNAME',
    'JMAP_USERNAME',
    'FASTMAIL_USERNAME',
    'FASTMAIL_DAV_USERNAME'
  );
}

export function hasJmapConfig(): boolean {
  try {
    loadJmapAuthConfig();
    return true;
  } catch {
    return false;
  }
}

export function hasDavConfig(): boolean {
  try {
    loadDavConfig();
    return true;
  } catch {
    return false;
  }
}
