/**
 * src/report/redact.ts
 *
 * Single source of truth for all secret-redaction patterns.
 *
 * B-4-5: Authorization-class headers (authorization, x-api-key, cookie, set-cookie)
 * B-4-6: Secret-pattern headers (api_key, api-key, secret, token, password)
 * B-4-7: Secret-pattern body values — regex on raw body string (recursive by nature, B-4-22)
 */

/** Headers whose names match this pattern have their values replaced with [REDACTED] */
const HEADER_REDACT_PATTERN =
  /authorization|x-api-key|cookie|set-cookie|api[_-]?key|secret|token|password/i;

/**
 * Body redaction pattern — applied as a raw string search.
 * Matches JSON key-value pairs at any nesting depth (B-4-22).
 * Group 1 = the full quoted key (including surrounding double-quotes).
 * Keys that CONTAIN the sensitive words as substrings are matched,
 * e.g. "clientSecret", "accessToken", "refreshToken", "api_key".
 * Replacement: $1: "[REDACTED]" — preserves the original key exactly.
 */
const BODY_REDACT_PATTERN =
  /("(?:[^"]*(?:password|secret|token|api[_-]?key)[^"]*)")\s*:\s*"[^"]*"/gi;

/**
 * Redact sensitive headers in place.
 * The header key is preserved; only the value is replaced.
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HEADER_REDACT_PATTERN.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Redact sensitive values in a JSON body string.
 * Non-JSON strings are returned unchanged.
 * Redaction is applied via regex on the raw string — covers any nesting depth (B-4-22).
 */
export function redactBody(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  // Apply pattern directly to raw string — matches at any depth.
  // $1 = the full quoted key (e.g. "password" or "clientSecret")
  return body.replace(BODY_REDACT_PATTERN, `$1: "[REDACTED]"`);
}
