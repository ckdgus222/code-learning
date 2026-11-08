import { afterEach, expect, it, vi } from 'vitest';
import { net } from 'electron';
import { checkForUpdate, LATEST_RELEASE_API } from '../src/main/update-check';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());
const retryMessage = '새 버전을 확인하지 못했어요. 잠시 뒤 다시 눌러 주세요.';
const connectionMessage = '새 버전을 확인하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.';

it('requests only the fixed API with anonymous headers and a ten second timeout', async () => {
  expect(LATEST_RELEASE_API).toBe('https://api.github.com/repos/ckdgus222/code-learning/releases/latest');
  const signal = new AbortController().signal;
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
  const fetcher = vi.fn(async () => Response.json({ tag_name: 'v1.1.0', html_url: 'https://untrusted.example/' }));
  expect(await checkForUpdate('1.0.0', fetcher)).toEqual({ current: '1.0.0', latest: '1.1.0', status: 'newer' });
  expect(fetcher.mock.calls).toEqual([[LATEST_RELEASE_API, {
    method: 'GET', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Code-Learning/1.0.0' },
    credentials: 'omit', signal,
  }]]);
  expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
});

it.each([
  ['v1.1.0', 'newer'], ['1.1.0', 'newer'], ['1.0.0', 'latest'], ['0.99.99', 'latest'],
  ['1.0.1', 'newer'], ['2.0.0', 'newer'], ['1.10.0', 'newer'],
])('compares numeric components of %s', async (tag, status) => {
  expect(await checkForUpdate('1.0.0', async () => Response.json({ tag_name: tag })))
    .toEqual({ current: '1.0.0', latest: tag.replace(/^v/, ''), status });
});

it('compares large numeric components without rounding', async () => {
  expect(await checkForUpdate('1.9007199254740992.0', async () => Response.json({ tag_name: '1.9007199254740993.0' })))
    .toMatchObject({ status: 'newer' });
});

it.each([
  ['1.9.0', '1.10.0', 'newer'], ['1.10.0', '1.9.99', 'latest'], ['1.1.2', '1.1.1', 'latest'],
])('compares %s to %s in numeric order', async (current, latest, status) => {
  expect(await checkForUpdate(current, async () => Response.json({ tag_name: latest }))).toMatchObject({ status });
});

it('treats 404 as no public release without parsing its body', async () => {
  expect(await checkForUpdate('1.0.0', async () => new Response('not JSON', { status: 404 })))
    .toEqual({ current: '1.0.0', latest: null, status: 'none' });
});

it.each([403, 500])('rejects HTTP %s with a safe retry message', async status => {
  await expect(checkForUpdate('1.0.0', async () => new Response('private error details', { status })))
    .rejects.toMatchObject({ code: 'IO', message: retryMessage });
});

it.each([
  ['<html>bad response</html>', connectionMessage], ['{broken', connectionMessage],
  ['{}', retryMessage], ['{"tag_name":42}', retryMessage],
  ['{"tag_name":"nightly"}', retryMessage], ['{"tag_name":"v1.1.0-beta.1"}', retryMessage],
  ['{"tag_name":"1.1"}', retryMessage], ['{"tag_name":"v1.1.0\n"}', connectionMessage],
])('rejects invalid release data: %s', async (body, message) => {
  await expect(checkForUpdate('1.0.0', async () => new Response(body))).rejects.toMatchObject({ code: 'IO', message });
});

it('rejects a declared body over 1 MB before reading it and cancels the stream', async () => {
  const response = new Response('{"tag_name":"1.1.0"}', { headers: { 'content-length': String(1024 * 1024 + 1) } });
  const read = vi.spyOn(ReadableStreamDefaultReader.prototype, 'read');
  const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
  await expect(checkForUpdate('1.0.0', async () => response)).rejects.toMatchObject({ code: 'IO' });
  expect(read).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it.each([false, true])('rejects streamed bytes over 1 MB even with a lying length: %s', async declared => {
  const cancel = vi.fn();
  let chunk = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode(chunk++ === 0 ? ' '.repeat(1024 * 1024) : '{"tag_name":"1.1.0"}'));
    },
    cancel,
  });
  await expect(checkForUpdate('1.0.0', async () => new Response(body, { headers: declared ? { 'content-length': '10' } : {} })))
    .rejects.toMatchObject({ code: 'IO' });
  expect(cancel).toHaveBeenCalledOnce();
});

it('accepts a valid response exactly 1 MB long', async () => {
  const body = '{"tag_name":"v1.1.0"}'.padEnd(1024 * 1024, ' ');
  expect(await checkForUpdate('1.0.0', async () => new Response(body, { headers: { 'content-length': String(body.length) } })))
    .toMatchObject({ status: 'newer' });
});

it('counts UTF-8 bytes rather than characters toward the body limit', async () => {
  const body = JSON.stringify({ tag_name: '1.1.0', notes: '가'.repeat(400_000) });
  expect(body.length).toBeLessThan(1024 * 1024);
  await expect(checkForUpdate('1.0.0', async () => new Response(body))).rejects.toMatchObject({ code: 'IO' });
});

it.each(['offline', 'abort'])('hides network details after %s and allows another attempt', async failure => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const fetcher = vi.fn((_url: string, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    if (failure === 'offline') { reject(new Error('private connection details')); return; }
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  const result = checkForUpdate('1.0.0', fetcher);
  const rejected = expect(result).rejects.toMatchObject({ code: 'IO', message: connectionMessage });
  controller.abort(new DOMException('private timeout details', 'TimeoutError'));
  await rejected;
  expect(await checkForUpdate('1.0.0', async () => Response.json({ tag_name: '1.0.0' }))).toMatchObject({ status: 'latest' });
});

it('handles an aborted body read without leaking the underlying error', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('private timeout', 'AbortError')); } }));
  await expect(checkForUpdate('1.0.0', async () => response)).rejects.toMatchObject({ code: 'IO', message: connectionMessage });
});

it('shares the same pending promise and sends a new request after completion', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const first = checkForUpdate('1.0.0', fetcher);
  const second = checkForUpdate('1.0.0', fetcher);
  expect(first).toBe(second);
  expect(fetcher).toHaveBeenCalledOnce();
  finish(Response.json({ tag_name: '1.1.0' }));
  await Promise.all([first, second]);
  const third = checkForUpdate('1.0.0', fetcher);
  expect(fetcher).toHaveBeenCalledTimes(2);
  finish(Response.json({ tag_name: '1.1.0' }));
  await third;
});

it.each(['nightly', '1.0', '1.0.0-beta.1'])('rejects invalid current version %s before requesting', async current => {
  const fetcher = vi.fn();
  await expect(checkForUpdate(current, fetcher)).rejects.toMatchObject({ code: 'INTERNAL' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('looks up net.fetch at call time', async () => {
  const fetcher = vi.spyOn(net, 'fetch').mockResolvedValueOnce(Response.json({ tag_name: '1.1.0' }));
  await checkForUpdate('1.0.0');
  expect(fetcher).toHaveBeenCalledOnce();
});
