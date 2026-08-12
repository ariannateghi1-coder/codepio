import { defineConfig } from "vitest/config"; import path from "path"; export default defineConfig({test:{environment:"node"},resolve:{alias:{"@":path.resolve(__dirname,"src"),
  // "server-only" unconditionally throws when imported outside of Next.js's
  // webpack build (it relies on a special-cased no-op resolution that only
  // Next's bundler provides) — every unit test that transitively imports a
  // module tagged `import "server-only"` (security.ts, support-service.ts,
  // badges.ts, push.ts, prisma.ts) crashed under plain vitest/node without
  // this alias pointing it at a harmless stub instead.
  "server-only": path.resolve(__dirname, "src/tests/__mocks__/server-only.ts"),
}}});
