/**
 * Open-redirect guard, shared by the middleware and the client forms.
 *
 * Only same-site absolute paths are accepted. Rejected: protocol-relative
 * (`//evil.com`), absolute URLs, backslash variants that some parsers normalise
 * to a slash, and auth pages themselves (which would bounce in a loop).
 */
const BLOCKED_PREFIXES = ["/auth/login", "/auth/register"];

export function safeNextPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.includes("://") || value.includes("\\")) return null;
  if (BLOCKED_PREFIXES.some((prefix) => value.startsWith(prefix))) return null;
  return value;
}
