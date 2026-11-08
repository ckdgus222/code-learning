import { net } from 'electron';
import { z } from 'zod';
import type { UpdateCheck } from '../shared/contracts';
import { AppError } from '../shared/errors';

export const RELEASES_PAGE = 'https://github.com/ckdgus222/code-learning/releases/latest';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/ckdgus222/code-learning/releases/latest';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;
const releaseSchema = z.object({ tag_name: z.string().regex(VERSION) });
const RETRY_MESSAGE = '새 버전을 확인하지 못했어요. 잠시 뒤 다시 눌러 주세요.';
const CONNECTION_MESSAGE = '새 버전을 확인하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.';
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let pending: Promise<UpdateCheck> | null = null;

export function checkForUpdate(current: string, fetcher: Fetcher = (url, init) => net.fetch(url, init)): Promise<UpdateCheck> {
  if (pending) return pending;
  pending = fetchUpdate(current, fetcher).finally(() => { pending = null; });
  return pending;
}

async function fetchUpdate(current: string, fetcher: Fetcher): Promise<UpdateCheck> {
  const currentParts = VERSION.exec(current);
  if (!currentParts) throw new AppError('INTERNAL', '현재 앱 버전을 확인하지 못했어요.');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(LATEST_RELEASE_API, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `Code-Learning/${current}`,
      },
      credentials: 'omit',
      signal: AbortSignal.timeout(10_000),
    });
    // Cancel unread bodies too, including errors and responses rejected by their declared size.
    reader = response.body?.getReader();
    if (response.status === 404) return { current, latest: null, status: 'none' };
    if (!response.ok) throw new AppError('IO', RETRY_MESSAGE);
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !reader) {
      throw new AppError('IO', RETRY_MESSAGE);
    }
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new AppError('IO', RETRY_MESSAGE);
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const parsed = releaseSchema.safeParse(JSON.parse(body));
    if (!parsed.success) throw new AppError('IO', RETRY_MESSAGE);
    const latest = parsed.data.tag_name.replace(/^v/, '');
    const latestParts = latest.split('.').map(BigInt);
    const installedParts = currentParts.slice(1).map(BigInt);
    const difference = latestParts.findIndex((part, index) => part !== installedParts[index]);
    const newer = difference !== -1 && latestParts[difference] > installedParts[difference];
    return { current, latest, status: newer ? 'newer' : 'latest' };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('IO', CONNECTION_MESSAGE);
  } finally {
    void reader?.cancel().catch(() => {});
  }
}
