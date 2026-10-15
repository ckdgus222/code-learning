import { defineConfig } from 'vite';
export default defineConfig(({ command }) => ({
  server: { host: '127.0.0.1' },
  plugins: [{ name: 'packaged-csp', transformIndexHtml(html) {
    return command === 'build' ? html.replace("connect-src 'self' ws://127.0.0.1:*", "connect-src 'none'") : html;
  } }],
}));
