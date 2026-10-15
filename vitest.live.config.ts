import { defineConfig } from 'vitest/config';
// Real Codex requests with the user's own account: run only through `npm run test:codex-live`.
export default defineConfig({ test: { include: ['tests/live/**/*.live.ts'], environment: 'node', testTimeout: 180_000 } });
