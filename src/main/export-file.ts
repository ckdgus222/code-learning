import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpath, stat, open, rename, unlink } from 'node:fs/promises';
import { AppError } from '../shared/errors';

/** Writes the chosen Markdown file outside the project; returns only its name. */
export async function saveExport(projectRoot: string, file: string, text: string, stopped: () => AppError | null): Promise<string> {
  if (path.extname(file).toLowerCase() !== '.md') throw new AppError('UNSUPPORTED', 'Markdown 파일(.md)로만 저장할 수 있어요.');
  let folder: string;
  try {
    folder = await realpath(path.dirname(file));
    const project = await stat(projectRoot, { bigint: true });
    let ancestor = folder;
    while (true) {
      const identity = await stat(ancestor, { bigint: true });
      if (identity.dev === project.dev && identity.ino === project.ino) throw new AppError('UNSUPPORTED', '열어 둔 프로젝트 폴더 안에는 저장하지 않아요. 프로젝트 밖의 위치를 골라 주세요.');
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('IO', '고른 위치에 저장할 수 없어요.');
  }
  const ended = stopped();
  if (ended) throw ended;
  const temporary = path.join(folder, `.map-export-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx');
  } catch {
    // A failed exclusive create must not remove a file that was already there.
    throw new AppError('IO', '파일을 저장하지 못했어요.');
  }
  try {
    await handle.writeFile(text, 'utf8');
    await handle.close();
    const ended = stopped();
    if (ended) throw ended;
    await rename(temporary, path.join(folder, path.basename(file)));
  } catch (error) {
    await handle.close().catch(() => {});
    try { await unlink(temporary); } catch { throw new AppError('IO', '파일을 저장하지 못했어요.'); }
    if (error instanceof AppError) throw error;
    throw new AppError('IO', '파일을 저장하지 못했어요.');
  }
  return path.basename(file);
}
