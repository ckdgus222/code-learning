import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewSettingsStore } from '../src/main/view-settings';
import { defaultViewSettings, type ViewSettings } from '../src/shared/contracts';
import { failure } from '../src/shared/errors';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }));

let directory: string;
let file: string;
let theme: { themeSource: ViewSettings['screen'] };
let store: ViewSettingsStore;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'view-settings-'));
  file = path.join(directory, 'view-settings.json');
  theme = { themeSource: 'dark' };
  store = new ViewSettingsStore(file, theme);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('view settings storage', () => {
  it.each([undefined, '{broken', '{}', 'null', '{"screen":"blue","codeColors":"default"}',
    '{"screen":"light","codeColors":"contrast","extra":true}'])('uses defaults for a missing or invalid file: %s', async contents => {
    if (contents !== undefined) await writeFile(file, contents);
    await store.load();
    expect(store.get()).toEqual(defaultViewSettings);
    expect(theme.themeSource).toBe('system');
  });

  it.each(['system', 'light', 'dark'] as const)('persists and restores %s with high contrast before use', async screen => {
    await store.load();
    const settings = { screen, codeColors: 'contrast' } as const;
    expect(await store.set(settings)).toEqual(settings);
    expect(theme.themeSource).toBe(screen);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(settings);
    expect(await readdir(directory)).toEqual(['view-settings.json']);
    const restoredTheme = { themeSource: 'light' as const };
    const restored = new ViewSettingsStore(file, restoredTheme);
    await restored.load();
    expect(restored.get()).toEqual(settings);
    expect(restoredTheme.themeSource).toBe(screen);
  });

  it.each([null, {}, { screen: 'blue', codeColors: 'default' }, { screen: 'light', codeColors: 'unknown' },
    { screen: 'light', codeColors: 'default', extra: true }])('rejects invalid requests without writing: %j', async input => {
    await store.load();
    expect(await store.set(input).catch(failure)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(store.get()).toEqual(defaultViewSettings);
    expect(theme.themeSource).toBe('system');
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['writeFile', 'rename'] as const)('keeps the last saved value after %s fails and retries', async operation => {
    await store.load();
    const saved = { screen: 'dark', codeColors: 'contrast' } as const;
    await store.set(saved);
    theme.themeSource = 'light';
    vi.spyOn(fs, operation).mockRejectedValueOnce(new Error('private filesystem details'));
    const next = { screen: 'light', codeColors: 'default' } as const;
    expect(await store.set(next).catch(failure)).toEqual({ ok: false, code: 'IO', message: '보기 설정을 저장하지 못했어요. 다시 골라 주세요.' });
    expect(store.get()).toEqual(saved);
    expect(theme.themeSource).toBe('dark');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(saved);
    expect(await store.set(next)).toEqual(next);
    expect(theme.themeSource).toBe('light');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(next);
  });

  it('serializes concurrent writes and keeps the last request', async () => {
    await store.load();
    const originalWrite = fs.writeFile;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writes = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await gate;
      return originalWrite(...args);
    });
    const first = store.set({ screen: 'dark', codeColors: 'contrast' });
    const last = { screen: 'light', codeColors: 'default' } as const;
    const second = store.set(last);
    await Promise.resolve();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual(defaultViewSettings);
    expect(theme.themeSource).toBe('system');
    release();
    await Promise.all([first, second]);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(store.get()).toEqual(last);
    expect(theme.themeSource).toBe('light');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(last);
  });
});
