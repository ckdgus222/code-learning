import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, realpath, rm, symlink, link, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectAiContext, MAX_CONTEXT_FILE_BYTES, MAX_CONTEXT_BYTES } from '../src/core/ai/context';
import { readAllowed, scanProject } from '../src/core/project/files';
import type { Evidence, SourceView } from '../src/shared/contracts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(extra: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-context-')));
  roots.push(root);
  for (const [name, text] of Object.entries({ 'main.ts': 'const answer = helper();\n', 'helper.ts': 'export const helper = () => 42;\n', ...extra })) {
    await writeFile(path.join(root, name), text);
  }
  const project = await scanProject(root, randomUUID());
  const file = project.files.find(file => file.relativePath === 'main.ts')!;
  const { text, hash } = await readAllowed(root, file.relativePath);
  const source: SourceView = { projectId: project.id, fileId: file.id, relativePath: file.relativePath, text, hash,
    analysis: { language: 'typescript', symbols: [], imports: [], warnings: [] } };
  const evidence: Evidence = { id: randomUUID(), projectId: project.id, fileId: file.id, fileHash: hash,
    startUtf16: 0, endUtf16: Math.min(12, text.length), startLine: 1, endLine: 1 };
  const context = new ProjectAiContext(root, project);
  const controller = new AbortController();
  const capture = () => context.capture(source, evidence, 7, controller.signal);
  const id = (name: string) => project.files.find(file => file.relativePath === name)!.id;
  return { root, project, source, evidence, context, controller, capture, id };
}

describe('app-mediated project AI reads with real temporary files', () => {
  it('provides selected code, complete source and related source with resolvable UUID evidence without changing files', async () => {
    const f = await fixture();
    const before = await Promise.all(f.project.files.map(async file => ({ text: await readFile(path.join(f.root, file.relativePath)), stat: await stat(path.join(f.root, file.relativePath)) })));
    const snapshot = await f.capture();
    await f.context.expand(snapshot, [f.id('helper.ts')], f.controller.signal);
    await f.context.revalidate(snapshot, f.controller.signal);
    expect(snapshot.code).toBe(f.source.text.slice(0, 12));
    expect(snapshot.files.map(file => file.relativePath)).toEqual(['main.ts', 'helper.ts']);
    for (const file of snapshot.files) {
      expect(file.evidence.id).toMatch(/^[\da-f-]{36}$/);
      expect(f.context.lookup(file.evidence.id)).toEqual(file.evidence);
      expect(file.evidence.endUtf16).toBe(file.code.length);
    }
    for (const [index, file] of f.project.files.entries()) {
      expect(await readFile(path.join(f.root, file.relativePath))).toEqual(before[index].text);
      const after = await stat(path.join(f.root, file.relativePath));
      expect([after.mtimeMs, after.ctimeMs, after.size]).toEqual([before[index].stat.mtimeMs, before[index].stat.ctimeMs, before[index].stat.size]);
    }
    f.context.clear();
    expect(f.context.lookup(snapshot.files[1].evidence.id)).toBeUndefined();
  });

  it.each(['unknown', 'path', 'duplicate', 'too-many'])('rejects %s file requests before expansion', async kind => {
    const f = await fixture();
    const snapshot = await f.capture();
    const ids = kind === 'unknown' ? [randomUUID()] : kind === 'path' ? ['../outside.ts'] : kind === 'duplicate'
      ? [f.id('helper.ts'), f.id('helper.ts')] : Array.from({ length: 5 }, () => randomUUID());
    await expect(f.context.expand(snapshot, ids, f.controller.signal)).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(snapshot.files).toHaveLength(1);
  });

  it('omits sensitive and ignored files from the advertised list', async () => {
    const f = await fixture({ '.env': 'secret', 'credentials.json': '{}', '.gitignore': 'ignored.ts\n', 'ignored.ts': 'secret' });
    const snapshot = await f.capture();
    expect(snapshot.availableFiles.map(file => file.relativePath)).toEqual(['.gitignore', 'helper.ts', 'main.ts']);
  });

  it.each(['ignore', 'symlink', 'hardlink'])('rechecks %s restrictions when a listed file is requested', async kind => {
    const f = await fixture();
    const snapshot = await f.capture();
    if (kind === 'ignore') await writeFile(path.join(f.root, '.gitignore'), 'helper.ts\n');
    else {
      await unlink(path.join(f.root, 'helper.ts'));
      if (kind === 'symlink') await symlink('/etc/passwd', path.join(f.root, 'helper.ts'));
      else await link(path.join(f.root, 'main.ts'), path.join(f.root, 'helper.ts'));
    }
    await expect(f.context.expand(snapshot, [f.id('helper.ts')], f.controller.signal)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    expect(snapshot.files).toHaveLength(1);
  });

  it.each(['main.ts', 'helper.ts'])('detects changes to %s before later stages', async name => {
    const f = await fixture();
    const snapshot = await f.capture();
    await f.context.expand(snapshot, [f.id('helper.ts')], f.controller.signal);
    await writeFile(path.join(f.root, name), 'changed();\n');
    await expect(f.context.revalidate(snapshot, f.controller.signal)).rejects.toMatchObject({ code: 'CHANGED' });
  });

  it('rejects a stale selected source before sending it', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'main.ts'), 'changed();');
    await expect(f.capture()).rejects.toMatchObject({ code: 'CHANGED' });
  });

  it('refuses selected code over the size limit, as asking about a whole long function can hit', async () => {
    const f = await fixture({ 'main.ts': 'a'.repeat(MAX_CONTEXT_FILE_BYTES + 1) });
    const whole = { ...f.evidence, endUtf16: f.source.text.length };
    await expect(f.context.capture(f.source, whole, 7, f.controller.signal))
      .rejects.toMatchObject({ code: 'LIMIT', message: '선택한 코드가 너무 큽니다. 더 작은 구문을 선택해 주세요.' });
  });

  it('omits oversized complete files while preserving the selected fragment and limitations', async () => {
    const f = await fixture({ 'main.ts': 'a'.repeat(MAX_CONTEXT_FILE_BYTES + 1), 'helper.ts': 'b'.repeat(MAX_CONTEXT_FILE_BYTES + 1) });
    const snapshot = await f.capture();
    await f.context.expand(snapshot, [f.id('helper.ts')], f.controller.signal);
    expect(snapshot.code).toHaveLength(12);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.limitations.join(' ')).toContain('main.ts');
    expect(snapshot.limitations.join(' ')).toContain('helper.ts');
  });

  it('bounds combined context bytes and reports skipped related files', async () => {
    const f = await fixture(Object.fromEntries(['a.ts', 'b.ts', 'c.ts', 'd.ts'].map(name => [name, 'x'.repeat(MAX_CONTEXT_FILE_BYTES)])));
    const snapshot = await f.capture();
    await f.context.expand(snapshot, ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map(f.id), f.controller.signal);
    expect(Buffer.byteLength(snapshot.code) + snapshot.files.reduce((sum, file) => sum + Buffer.byteLength(file.code), 0)).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    expect(snapshot.files.some(file => file.relativePath === 'd.ts')).toBe(false);
    expect(snapshot.limitations.join(' ')).toContain('d.ts');
  });

  it('cancels capture, expansion and revalidation without adding more context', async () => {
    const f = await fixture();
    const snapshot = await f.capture();
    f.controller.abort();
    await expect(f.capture()).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(f.context.expand(snapshot, [f.id('helper.ts')], f.controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(f.context.revalidate(snapshot, f.controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(snapshot.files).toHaveLength(1);
  });

  it('keeps repeatedly selected evidence registered while evicting old inactive references at the 64-entry bound', async () => {
    const f = await fixture({ 'a.ts': 'a();', 'b.ts': 'b();', 'c.ts': 'c();' });
    const generated: Evidence[] = [];
    for (let turn = 0; turn < 20; turn++) {
      const snapshot = await f.capture();
      await f.context.expand(snapshot, ['helper.ts', 'a.ts', 'b.ts', 'c.ts'].map(f.id), f.controller.signal);
      generated.push(...snapshot.files.map(file => file.evidence));
      expect(f.context.lookup(f.evidence.id)).toEqual(f.evidence);
      for (const file of snapshot.files) expect(f.context.lookup(file.evidence.id)).toEqual(file.evidence);
      const registered = [f.evidence, ...generated].filter(evidence => f.context.lookup(evidence.id));
      expect(registered).toHaveLength(Math.min(64, 1 + generated.length));
    }
    expect(generated).toHaveLength(100);
    expect(f.context.lookup(generated[0].id)).toBeUndefined();
    expect(generated.slice(0, 37).every(evidence => !f.context.lookup(evidence.id))).toBe(true);
    expect(generated.slice(-63).every(evidence => f.context.lookup(evidence.id))).toBe(true);
  });

  it('rejects an already cancelled expansion even when no related files were requested', async () => {
    const f = await fixture();
    const snapshot = await f.capture();
    const before = structuredClone(snapshot);
    f.controller.abort();
    await expect(f.context.expand(snapshot, [], f.controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(snapshot).toEqual(before);
  });

});
