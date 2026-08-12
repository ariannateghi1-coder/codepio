// Vitest stub for the "server-only" package (see vitest.config.ts alias).
// The real package unconditionally throws on import outside of Next.js's
// webpack build; under plain Node/vitest that would crash every test that
// touches a server-only module, so this replaces it with a no-op here.
export {};
