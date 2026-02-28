import { randomUUID } from 'node:crypto';

export type CreateContactInput = {
  fullName: string;
  emails?: string[];
  phones?: string[];
  note?: string;
};

function esc(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

export function buildVCard(input: CreateContactInput): { uid: string; vcard: string; filename: string } {
  const uid = randomUUID();
  const lines: string[] = [];
  lines.push('BEGIN:VCARD');
  lines.push('VERSION:3.0');
  lines.push(`UID:${uid}`);
  lines.push(`FN:${esc(input.fullName)}`);
  // vCard 3.0 requires N; do a naive split.
  const parts = input.fullName.trim().split(/\s+/);
  const family = parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
  const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
  lines.push(`N:${esc(family)};${esc(given)};;;`);
  for (const email of input.emails || []) {
    lines.push(`EMAIL;TYPE=INTERNET:${esc(email)}`);
  }
  for (const tel of input.phones || []) {
    lines.push(`TEL;TYPE=CELL:${esc(tel)}`);
  }
  if (input.note) lines.push(`NOTE:${esc(input.note)}`);
  lines.push('END:VCARD');
  const vcard = lines.join('\r\n') + '\r\n';
  const filename = `${uid}.vcf`;
  return { uid, vcard, filename };
}

export function parseVCardSummary(vcard: string): { uid?: string; fullName?: string; emails: string[]; phones: string[] } {
  const unfolded = vcard.replace(/\r?\n[ \t]/g, '');
  const getAll = (key: string): string[] => {
    const re = new RegExp(`\\n${key}[^:]*:(.*)`, 'g');
    const out: string[] = [];
    for (;;) {
      const m = re.exec(unfolded);
      if (!m) break;
      out.push((m[1] || '').trim());
    }
    return out;
  };
  const getOne = (key: string): string | undefined => {
    const m = unfolded.match(new RegExp(`\\n${key}[^:]*:(.*)`));
    return m?.[1]?.trim();
  };
  return {
    uid: getOne('UID'),
    fullName: getOne('FN'),
    emails: getAll('EMAIL'),
    phones: getAll('TEL'),
  };
}
