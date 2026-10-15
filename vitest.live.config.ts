import { defineConfig } from 'vitest/config';
// Real Codex and Antigravity requests with the user's own account: run only through `npm run test:codex-live` or `npm run test:agy-live`.
export default defineConfig({ test: { include: ['tests/live/**/*.live.ts'], environment: 'node', testTimeout: 180_000 } });
