import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { signMacPackages } from './scripts/mac-signing';

export default {
  packagerConfig: {
    // The TypeScript checker (plan v2.3 V-2) runs as a binary and reads its own lib files directly, so it stays unpacked.
    asar: { unpack: '{**/*.node,**/*.dylib,**/node_modules/@typescript/typescript-*/lib/**}' },
    appBundleId: 'local.codelearning.app',
    executableName: 'Code Learning',
    icon: 'assets/icon/icon',
    ignore: (file: string) => !!file && !/^\/(?:\.vite|node_modules)(?:\/|$)/.test(file),
  },
  makers: [new MakerSquirrel({
    name: 'code_learning',
    authors: 'ckdgus222',
    description: 'Read-only app for exploring unfamiliar TypeScript and JavaScript projects',
    setupExe: 'Code-Learning-win-x64-Setup.exe',
    setupIcon: 'assets/icon/icon.ico',
    iconUrl: 'https://raw.githubusercontent.com/ckdgus222/code-learning/main/assets/icon/icon.ico',
    noMsi: true,
  }, ['win32'])],
  // FusesPlugin runs in packageAfterCopy, before this final inside-out signing and verification.
  hooks: { postPackage: signMacPackages },
  // These pinned packages ship N-API prebuilts verified in Electron on macOS arm64.
  // tree-sitter 0.21's source build selects C++17, incompatible with Electron 44 headers.
  rebuildConfig: { ignoreModules: ['tree-sitter', 'tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-typescript'] },
  plugins: [new VitePlugin({
    build: [
      { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
      { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      { entry: 'src/workers/analysis.ts', config: 'vite.main.config.ts', target: 'main' },
    ],
    renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
  }), new FusesPlugin({
    version: FuseVersion.V1,
    // postPackage signs the finished bundle, so the plugin must not reset its signature early.
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Keep GrantFileProtocolExtraPrivileges at its default: file:// loads our module scripts.
  })],
};
