import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export function releaseVersion({ input, ref, packageVersion }) {
  const version = input || (ref?.startsWith('refs/tags/v') ? ref.slice('refs/tags/v'.length) : '');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Release version must have the form 1.0.0.');
  }
  if (version !== packageVersion) throw new Error('Release version must match package.json.');
  return version;
}

// gh accepts an argument array and resolves to stdout; command failures must reject.
export async function updateDraft({ version, sha, files, gh }) {
  releaseVersion({ input: version, packageVersion: version });
  if (typeof sha !== 'string' || sha.length !== 40 || !/^[a-f\d]{40}$/i.test(sha)) {
    throw new Error('A full build commit SHA is required.');
  }
  const tag = `v${version}`;
  // A successful, paginated lookup distinguishes absence from authentication/network errors.
  const release = (await gh([
    'api', 'repos/{owner}/{repo}/releases?per_page=100', '--paginate',
    '--jq', `.[] | select(.tag_name == "${tag}") | {draft: .draft}`,
  ])).trim();
  if (release && JSON.parse(release)?.draft !== true) throw new Error('Refusing to modify a published release.');

  const refs = JSON.parse(await gh(['api', `repos/{owner}/{repo}/git/matching-refs/tags/${tag}`]));
  if (refs.some(ref => ref.ref === `refs/tags/${tag}`)) {
    // refs/tags/… resolves annotated tags to their commit as well as lightweight tags;
    // GitHub answers 'tags/…' with 422 for an annotated tag.
    const tagSha = (await gh(['api', `repos/{owner}/{repo}/commits/refs/tags/${tag}`, '--jq', '.sha'])).trim();
    if (tagSha !== sha) throw new Error('Existing tag does not match the build commit.');
  }

  if (!release) {
    await gh([
      'release', 'create', tag, ...files, '--draft', '--target', sha,
      '--title', `Code Learning ${version}`, '--notes', '공개 전 초안입니다. 릴리스 노트는 공개할 때 채웁니다.',
    ]);
    return;
  }
  await gh(['release', 'edit', tag, '--target', sha]);
  await gh(['release', 'upload', tag, ...files, '--clobber']);
}

async function main() {
  const command = process.argv[2];
  if (command !== 'version' && command !== 'draft') throw new Error('Expected version or draft command.');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = releaseVersion({
    input: process.env.RELEASE_VERSION, ref: process.env.GITHUB_REF, packageVersion: pkg.version,
  });
  if (command === 'version') {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    console.log(version);
    return;
  }

  const directory = path.resolve(process.env.RELEASE_DIR || 'artifacts');
  const names = ['Code-Learning-mac-arm64.dmg', 'Code-Learning-win-x64-Setup.exe'];
  const files = names.map(name => path.join(directory, name));
  const sums = [];
  for (const [index, file] of files.entries()) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    sums.push(`${hash.digest('hex')}  ${names[index]}\n`);
  }
  const checksumFile = path.join(directory, 'SHA256SUMS.txt');
  await writeFile(checksumFile, sums.join(''));
  const run = promisify(execFile);
  await updateDraft({
    version, sha: process.env.GITHUB_SHA, files: [...files, checksumFile],
    gh: async args => (await run('gh', args, { encoding: 'utf8' })).stdout,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
