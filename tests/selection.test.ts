import { describe, expect, it } from 'vitest';
import { showsFiles, type View } from '../src/renderer/selection';

describe('file list visibility', () => {
  it.each<View>(['code', 'function'])('shows files in %s', view => {
    expect(showsFiles(view)).toBe(true);
  });

  it.each<View>(['overview', 'flow', 'map', 'changes'])('hides files in %s', view => {
    expect(showsFiles(view)).toBe(false);
  });
});
