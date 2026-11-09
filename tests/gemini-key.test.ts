import { mkdtemp, readFile, rm, stat, writeFile, readdir, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createGeminiKeyStore } from '../src/main/gemini-key';

let directory: string;
let file: string;
const key = 'fake-gemini-key-for-tests-only';
const crypto = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value.split('').reverse().join(''))),
  decryptString: vi.fn((value: Buffer) => value.toString().split('').reverse().join('')),
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-key-'));
  file = path.join(directory, 'key.bin');
  vi.clearAllMocks();
  crypto.isEncryptionAvailable.mockReturnValue(true);
  crypto.decryptString.mockImplementation(value => value.toString().split('').reverse().join(''));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('round trips only encrypted bytes, trims the key and reports no secret', async () => {
  const store = createGeminiKeyStore(file, crypto);
  expect(await store.read()).toBeNull();
  expect(await store.status()).toEqual({ saved: false, readable: false, canEncrypt: true });
  await store.save(`${key}\n`);
  expect(await store.read()).toBe(key);
  expect((await readFile(file)).includes(key)).toBe(false);
  expect(await store.status()).toEqual({ saved: true, readable: true, canEncrypt: true });
  expect(await readdir(directory)).toEqual(['key.bin']);
  await store.clear();
  await store.clear();
  expect(await store.read()).toBeNull();
  expect(await store.status()).toEqual({ saved: false, readable: false, canEncrypt: true });
});
it.skipIf(process.platform === 'win32')('writes with mode 0o600', async () => {
  await createGeminiKeyStore(file, crypto).save(key);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
it('refuses saving without encryption and writes nothing', async () => {
  crypto.isEncryptionAvailable.mockReturnValue(false);
  const store = createGeminiKeyStore(file, crypto);
  await expect(store.save(key)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(await readdir(directory)).toEqual([]);
  expect(await store.status()).toEqual({ saved: false, readable: false, canEncrypt: false });
  crypto.isEncryptionAvailable.mockReturnValue(true);
  expect((await store.status()).canEncrypt).toBe(false);
  await store.save(key);
  expect(await store.status()).toEqual({ saved: true, readable: true, canEncrypt: true });
});
it.each(['', '   ', 'x'.repeat(10), 'x'.repeat(300), 'x'.repeat(19), 'x'.repeat(201), 'x'.repeat(20) + '!', 'x'.repeat(20) + '\ny'])('rejects invalid key %# without writing', async value => {
  await expect(createGeminiKeyStore(file, crypto).save(value)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(await readdir(directory)).toEqual([]);
});
it.each([20, 200])('accepts the %i character boundary', async length => {
  const store = createGeminiKeyStore(file, crypto);
  await store.save('x'.repeat(length));
  expect(await store.read()).toBe('x'.repeat(length));
});
it('preserves saved status on decrypt failure and can replace the unreadable key', async () => {
  const store = createGeminiKeyStore(file, crypto);
  await writeFile(file, 'broken cipher');
  crypto.decryptString.mockImplementationOnce(() => { throw new Error('decrypt'); });
  expect(await store.read()).toBeNull();
  expect(await store.status()).toEqual({ saved: true, readable: false, canEncrypt: true });
  await store.save(key);
  expect(await store.status()).toEqual({ saved: true, readable: true, canEncrypt: true });
  expect(await store.read()).toBe(key);
});
it.each([false, true])('checks file presence without touching the keychain (saved: %s)', async saved => {
  if (saved) await writeFile(file, 'existing cipher');
  const touched = () => { throw new Error('keychain touched'); };
  const guardedCrypto = { isEncryptionAvailable: vi.fn(touched), encryptString: vi.fn(touched), decryptString: vi.fn(touched) };
  const store = createGeminiKeyStore(file, guardedCrypto);
  expect(await store.has()).toBe(saved);
  expect(await store.status()).toEqual({ saved, readable: saved, canEncrypt: true });
  for (const method of Object.values(guardedCrypto)) expect(method).not.toHaveBeenCalled();
  await expect(store.save(key)).rejects.toThrow('keychain touched');
  expect(guardedCrypto.isEncryptionAvailable).toHaveBeenCalledOnce();
  if (!saved) await writeFile(file, 'existing cipher');
  expect(await store.read()).toBeNull();
  expect(guardedCrypto.decryptString).toHaveBeenCalledOnce();
});
it('encrypts only when saving and decrypts only when reading', async () => {
  const store = createGeminiKeyStore(file, crypto);
  await store.save(key);
  expect(crypto.isEncryptionAvailable).toHaveBeenCalledOnce();
  expect(crypto.encryptString).toHaveBeenCalledExactlyOnceWith(key);
  expect(crypto.decryptString).not.toHaveBeenCalled();
  expect(await store.read()).toBe(key);
  expect(crypto.decryptString).toHaveBeenCalledOnce();
});
it('recovers readability after a later successful read without saving or clearing', async () => {
  const store = createGeminiKeyStore(file, crypto);
  await store.save(key);
  crypto.decryptString.mockImplementationOnce(() => { throw new Error('denied'); });
  expect(await store.read()).toBeNull();
  expect((await store.status()).readable).toBe(false);
  expect(await store.read()).toBe(key);
  expect((await store.status()).readable).toBe(true);
});
it('clears the failed-read flag when deleting a key', async () => {
  const store = createGeminiKeyStore(file, crypto);
  await writeFile(file, 'existing cipher');
  crypto.decryptString.mockImplementationOnce(() => { throw new Error('denied'); });
  expect(await store.read()).toBeNull();
  await store.clear();
  expect(await store.has()).toBe(false);
  await writeFile(file, 'restored cipher');
  expect((await store.status()).readable).toBe(true);
});
it('orders save and clear by request order and recovers after a failed operation', async () => {
  const store = createGeminiKeyStore(file, crypto);
  await Promise.all([store.save(key), store.clear()]);
  expect(await store.read()).toBeNull();
  await Promise.all([store.clear(), store.save(key)]);
  expect(await store.read()).toBe(key);
  const failed = store.save('bad');
  const saved = store.save(key);
  await expect(failed).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await saved;
  expect(await store.read()).toBe(key);
});
it('wraps file failures with fixed IO messages and cleans temporary files', async () => {
  await mkdir(file);
  const store = createGeminiKeyStore(file, crypto);
  await expect(store.save(key)).rejects.toMatchObject({ code: 'IO', message: 'Gemini API 키를 저장하지 못했어요.' });
  await expect(store.clear()).rejects.toMatchObject({ code: 'IO', message: 'Gemini API 키를 지우지 못했어요.' });
  expect(await readdir(directory)).toEqual(['key.bin']);
});
