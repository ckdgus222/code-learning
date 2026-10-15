import { VitePlugin } from '@electron-forge/plugin-vite';

export default {
  packagerConfig: {
    asar: { unpack: '**/*.{node,dylib}' },
    appBundleId: 'local.codelearning.app',
    executableName: 'Code Learning',
    ignore: (file: string) => !!file && !/^\/(?:\.vite|node_modules)(?:\/|$)/.test(file),
  },
  makers: [],
  // These pinned packages ship N-API prebuilts verified in Electron on macOS arm64.
  // tree-sitter 0.21's source build selects C++17, incompatible with Electron 44 headers.
  rebuildConfig: { ignoreModules: ['tree-sitter', 'tree-sitter-javascript', 'tree-sitter-typescript'] },
  plugins: [new VitePlugin({
    build: [
      { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
      { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      { entry: 'src/workers/analysis.ts', config: 'vite.main.config.ts', target: 'main' },
    ],
    renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
  })],
};
