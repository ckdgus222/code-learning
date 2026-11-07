import { describe, expect, it, vi } from 'vitest';

const { releaseVersion, updateDraft } = await import(new URL('../scripts/release-draft.mjs', import.meta.url).href);
const version = '1.0.0';
const sha = 'a'.repeat(40);
const files = ['Code-Learning-mac-arm64.dmg', 'Code-Learning-win-x64-Setup.exe', 'SHA256SUMS.txt'];

function fakeGh({ releases = [] as unknown[], refs = [] as unknown[], tagSha = sha } = {}) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'api' && args[1].includes('/releases?')) return releases.map(release => JSON.stringify(release)).join('\n');
    if (args[0] === 'api' && args[1].includes('/git/matching-refs/')) return JSON.stringify(refs);
    if (args[0] === 'api' && args[1].includes('/commits/')) return `${tagSha}\n`;
    if (args[0] === 'release' && ['create', 'edit', 'upload'].includes(args[1])) return '';
    throw new Error(`Unexpected gh command: ${args.join(' ')}`);
  });
}

describe('releaseVersion', () => {
  it('accepts a manual version', () => {
    expect(releaseVersion({ input: version, ref: 'refs/heads/main', packageVersion: version })).toBe(version);
  });

  it('accepts a version tag with no manual input', () => {
    expect(releaseVersion({ input: '', ref: 'refs/tags/v1.0.0', packageVersion: version })).toBe(version);
  });

  it.each(['1.0', 'v1.0.0; rm', '', '1.0.0-beta', ' 1.0.0', '1.0.0\n', '1.0.0\r', '1.0.0\r\n'])('rejects malformed input %j', input => {
    expect(() => releaseVersion({ input, packageVersion: input })).toThrow('form');
  });

  it.each(['refs/heads/v1.0.0', 'refs/tags/1.0.0', 'refs/tags/v1.0', undefined])('rejects a missing or invalid tag %j', ref => {
    expect(() => releaseVersion({ ref, packageVersion: version })).toThrow('form');
  });

  it.each([
    { input: '1.0.1' }, { ref: 'refs/tags/v1.0.1' },
  ])('rejects a version differing from package.json: %j', source => {
    expect(() => releaseVersion({ ...source, packageVersion: version })).toThrow('match package.json');
  });
});

describe('updateDraft with fake gh', () => {
  it('creates one draft with all three files and the exact build commit', async () => {
    const gh = fakeGh();
    await updateDraft({ version, sha, files, gh });
    expect(gh.mock.calls.filter(([args]) => args[0] === 'release')).toEqual([[
      ['release', 'create', 'v1.0.0', ...files, '--draft', '--target', sha,
        '--title', 'Code Learning 1.0.0', '--notes', '공개 전 초안입니다. 릴리스 노트는 공개할 때 채웁니다.'],
    ]]);
    expect(gh.mock.calls[0][0]).toEqual([
      'api', 'repos/{owner}/{repo}/releases?per_page=100', '--paginate',
      '--jq', '.[] | select(.tag_name == "v1.0.0") | {draft: .draft}',
    ]);
  });

  it('updates the target before replacing every draft asset', async () => {
    const gh = fakeGh({ releases: [{ draft: true }] });
    const newSha = 'b'.repeat(40);
    await updateDraft({ version, sha: newSha, files, gh });
    expect(gh.mock.calls.filter(([args]) => args[0] === 'release')).toEqual([
      [['release', 'edit', 'v1.0.0', '--target', newSha]],
      [['release', 'upload', 'v1.0.0', ...files, '--clobber']],
    ]);
  });

  it.each([false, undefined, 'true'])('refuses a release unless draft is explicitly true (%j)', async draft => {
    const gh = fakeGh({ releases: [{ draft }] });
    await expect(updateDraft({ version, sha, files, gh })).rejects.toThrow('published');
    expect(gh.mock.calls.filter(([args]) => args[0] === 'release')).toEqual([]);
  });

  it.each([{ releases: [] }, { releases: [{ draft: true }] }])('refuses a different tag commit before any mutation (%j)', async ({ releases }) => {
    const gh = fakeGh({ releases, refs: [{ ref: 'refs/tags/v1.0.0' }], tagSha: 'b'.repeat(40) });
    await expect(updateDraft({ version, sha, files, gh })).rejects.toThrow('tag does not match');
    expect(gh.mock.calls.filter(([args]) => args[0] === 'release')).toEqual([]);
  });

  it.each(['commit', 'tag'])('resolves an existing %s reference to its build commit', async type => {
    const gh = fakeGh({ refs: [{ ref: 'refs/tags/v1.0.0', object: { type, sha: 'c'.repeat(40) } }] });
    await updateDraft({ version, sha, files, gh });
    expect(gh).toHaveBeenCalledWith(['api', 'repos/{owner}/{repo}/commits/tags/v1.0.0', '--jq', '.sha']);
    expect(gh.mock.calls.at(-1)?.[0].slice(0, 3)).toEqual(['release', 'create', 'v1.0.0']);
  });

  it('does not confuse a tag prefix match with the requested tag', async () => {
    const gh = fakeGh({ refs: [{ ref: 'refs/tags/v1.0.01' }], tagSha: 'b'.repeat(40) });
    await updateDraft({ version, sha, files, gh });
    expect(gh.mock.calls.some(([args]) => args[1].includes('/commits/'))).toBe(false);
  });

  it.each([0, 1, 2])('propagates lookup failure at command %i without writing', async failureIndex => {
    const gh = fakeGh({ refs: [{ ref: 'refs/tags/v1.0.0' }] });
    const original = gh.getMockImplementation()!;
    const failure = new Error('GitHub unavailable or access denied');
    gh.mockImplementation(async args => {
      if (gh.mock.calls.length === failureIndex + 1) throw failure;
      return original(args);
    });
    await expect(updateDraft({ version, sha, files, gh })).rejects.toBe(failure);
    expect(gh.mock.calls.filter(([args]) => args[0] === 'release')).toEqual([]);
  });

  it('retries all three files after a partial upload failure', async () => {
    const gh = fakeGh({ releases: [{ draft: true }] });
    const original = gh.getMockImplementation()!;
    let failUpload = true;
    gh.mockImplementation(async args => {
      if (args[1] !== 'upload' || !failUpload) return original(args);
      failUpload = false;
      throw new Error('Second asset upload failed');
    });
    await expect(updateDraft({ version, sha, files, gh })).rejects.toThrow('Second asset');
    await updateDraft({ version, sha, files, gh });
    expect(gh.mock.calls.filter(([args]) => args[0] === 'release')).toEqual([
      [['release', 'edit', 'v1.0.0', '--target', sha]],
      [['release', 'upload', 'v1.0.0', ...files, '--clobber']],
      [['release', 'edit', 'v1.0.0', '--target', sha]],
      [['release', 'upload', 'v1.0.0', ...files, '--clobber']],
    ]);
  });

  it.each(['create', 'edit'])('propagates %s failure and stops', async command => {
    const gh = fakeGh({ releases: command === 'edit' ? [{ draft: true }] : [] });
    const original = gh.getMockImplementation()!;
    gh.mockImplementation(async args => {
      if (args[1] === command) throw new Error(`${command} failed`);
      return original(args);
    });
    await expect(updateDraft({ version, sha, files, gh })).rejects.toThrow(`${command} failed`);
    expect(gh.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it.each([
    { version: '1.0.0; echo unsafe', sha }, { version, sha: '' }, { version, sha: 'main' }, { version, sha: `${sha}\n` },
  ])('rejects invalid mutation arguments before calling gh: %j', async args => {
    const gh = fakeGh();
    await expect(updateDraft({ ...args, files, gh })).rejects.toThrow();
    expect(gh).not.toHaveBeenCalled();
  });

  it.each([{ releases: [] }, { releases: [{ draft: true }] }])('never sends publication flags (%j)', async ({ releases }) => {
    const gh = fakeGh({ releases });
    await updateDraft({ version, sha, files, gh });
    expect(gh.mock.calls.flat(2)).not.toContain('--draft=false');
    expect(gh.mock.calls.flat(2)).not.toContain('--latest');
  });
});
