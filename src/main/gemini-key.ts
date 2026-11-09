import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { AppError } from '../shared/errors';

export interface GeminiKeyStore {
  status(): Promise<{ saved: boolean; readable: boolean; canEncrypt: boolean }>;
  read(): Promise<string | null>;
  save(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function createGeminiKeyStore(file: string, crypto: Pick<Electron.SafeStorage,
  'isEncryptionAvailable' | 'encryptString' | 'decryptString'>): GeminiKeyStore {
  // Save and clear run one after another, so a clear sent after a save always lands last.
  let pending: Promise<void> = Promise.resolve();
  function queued(task: () => Promise<void>): Promise<void> {
    const operation = pending.then(task);
    pending = operation.catch(() => {});
    return operation;
  }
  async function status() {
    const canEncrypt = crypto.isEncryptionAvailable();
    let encrypted: Buffer;
    try { encrypted = await readFile(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { saved: false, readable: false, canEncrypt };
      throw new AppError('IO', 'Gemini API 키 상태를 확인하지 못했어요.');
    }
    try { return { saved: true, readable: !!crypto.decryptString(encrypted), canEncrypt }; }
    catch { return { saved: true, readable: false, canEncrypt }; }
  }
  async function read(): Promise<string | null> {
    try { return crypto.decryptString(await readFile(file)) || null; }
    catch { return null; }
  }
  function save(key: string): Promise<void> {
    return queued(async () => {
      const trimmed = key.trim();
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(trimmed)) throw new AppError('INVALID_REQUEST', 'Gemini API 키 형식을 확인해 주세요.');
      if (!crypto.isEncryptionAvailable()) throw new AppError('UNSUPPORTED', '이 컴퓨터에서 키를 안전하게 저장할 수 없어요');
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, crypto.encryptString(trimmed), { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        throw new AppError('IO', 'Gemini API 키를 저장하지 못했어요.');
      }
    });
  }
  function clear(): Promise<void> {
    return queued(async () => {
      try { await rm(file, { force: true }); }
      catch { throw new AppError('IO', 'Gemini API 키를 지우지 못했어요.'); }
    });
  }
  return { status, read, save, clear };
}
