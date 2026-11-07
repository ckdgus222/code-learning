import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { defaultViewSettings, viewSettingsSchema, type ViewSettings } from '../shared/contracts';
import { AppError } from '../shared/errors';

export class ViewSettingsStore {
  private current = { ...defaultViewSettings };
  private pending: Promise<void> = Promise.resolve();

  constructor(private file: string, private theme: { themeSource: ViewSettings['screen'] }) {}

  async load(): Promise<void> {
    try {
      this.current = viewSettingsSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      this.current = { ...defaultViewSettings };
    }
    this.theme.themeSource = this.current.screen;
  }

  get(): ViewSettings { return { ...this.current }; }

  async set(value: unknown): Promise<ViewSettings> {
    const parsed = viewSettingsSchema.safeParse(value);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', '잘못된 보기 설정입니다.');
    const save = this.pending.then(async () => {
      const temporary = `${this.file}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(parsed.data), 'utf8');
        await rename(temporary, this.file);
      } catch {
        this.theme.themeSource = this.current.screen;
        await rm(temporary, { force: true }).catch(() => {});
        throw new AppError('IO', '보기 설정을 저장하지 못했어요. 다시 골라 주세요.');
      }
      this.current = parsed.data;
      this.theme.themeSource = this.current.screen;
      return this.get();
    });
    // A failed write must not prevent the next request from trying again.
    this.pending = save.then(() => {}, () => {});
    return save;
  }
}
