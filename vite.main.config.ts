import { defineConfig } from 'vite';
export default defineConfig({
  build: { rollupOptions: { external: ['tree-sitter', 'tree-sitter-javascript', 'tree-sitter-typescript'] } },
});
