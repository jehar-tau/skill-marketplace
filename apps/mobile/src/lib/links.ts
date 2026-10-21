export type LinkKind = 'instagram' | 'facebook' | 'linkedin' | 'other';

const HOSTS: [LinkKind, RegExp][] = [
  ['instagram', /(^|\.)instagram\.com$|(^|\.)instagr\.am$/i],
  ['facebook', /(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)fb\.me$/i],
  ['linkedin', /(^|\.)linkedin\.com$/i],
];

function host(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return '';
  }
}

export function linkKind(url: string): LinkKind {
  const h = host(url);
  return HOSTS.find(([, re]) => re.test(h))?.[0] ?? 'other';
}

// What people type: "@name", "name", a bare domain or a full link. A plain name becomes that site's page.
export function toLink(kind: LinkKind, raw: string): string {
  const v = raw.trim();
  const plain = /^@?[A-Za-z0-9._-]{1,60}$/.test(v) && !/\.[a-z]{2,}$/i.test(v);
  if (!plain) return v;
  const name = v.replace(/^@/, '');
  if (kind === 'instagram') return `https://instagram.com/${name}`;
  if (kind === 'facebook') return `https://facebook.com/${name}`;
  if (kind === 'linkedin') return `https://linkedin.com/in/${name}`;
  return v;
}

export function linkLabel(url: string): string {
  const kind = linkKind(url);
  if (kind === 'instagram') return 'Instagram';
  if (kind === 'facebook') return 'Facebook';
  if (kind === 'linkedin') return 'LinkedIn';
  return host(url).replace(/^www\./, '') || url;
}
