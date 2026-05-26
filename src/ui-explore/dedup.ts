import { createHash } from 'crypto';

// Default query params to strip during URL canonicalization
const DEFAULT_BLACKLIST = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', '_ga', 'sessionId',
]);

/**
 * Canonicalize a URL for dedup purposes.
 * - Removes tracking/session params (and any caller-provided extras)
 * - Sorts remaining query params alphabetically
 * - Strips trailing slash from path (except root)
 * - Lowercases scheme + host
 */
export function canonicalizeUrl(raw: string, extraBlacklist: string[] = []): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Not a valid URL — return as-is
    return raw;
  }

  // Lowercase scheme + host
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  // Build merged blacklist
  const blacklist = new Set([...DEFAULT_BLACKLIST, ...extraBlacklist]);

  // Remove blacklisted params (check for prefix patterns like utm_*)
  const toDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (blacklist.has(key) || key.startsWith('utm_')) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    parsed.searchParams.delete(key);
  }

  // Sort remaining query params alphabetically
  parsed.searchParams.sort();

  // Strip trailing slash from path unless it's the root
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.toString();
}

/**
 * Structural hash of an HTML string.
 * Two pages with same DOM structure but different text content should hash identically.
 * Algorithm per Appendix B of spec.
 */
export function structuralHash(html: string): string {
  // 1. Strip text nodes (replace content between tags with placeholder)
  const noText = html.replace(/>([^<]+)</g, '>#TEXT<');

  // 2. Strip attribute values except type, role, aria-*, data-testid
  const noAttrs = noText.replace(
    /\s(\w[\w-]*)="[^"]*"/g,
    (match, attrName: string) => {
      const keep = /^(type|role|aria-|data-testid)/.test(attrName);
      return keep ? match : '';
    },
  );

  // 3. Normalize whitespace
  const normalized = noAttrs.replace(/\s+/g, ' ').trim();

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
