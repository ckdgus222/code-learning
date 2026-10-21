import { describe, expect, it } from 'vitest';
import { formatNextPath, nextRouteOf } from '../src/core/analysis/next-routes';

describe('Next routes from project paths', () => {
  it.each([
    ['web/app/page.tsx', 'web/app', 'page', '/'],
    ['web/src/app/(group)/@slot/dogs/[id]/page.jsx', 'web/src/app', 'page', '/dogs/:id'],
    ['web/app/docs/[...slug]/page.ts', 'web/app', 'page', '/docs/:slug*'],
    ['web/app/docs/[[...slug]]/page.js', 'web/app', 'page', '/docs/:slug*'],
    ['web/app/dashboard/app/page.tsx', 'web/app', 'page', '/dashboard/app'],
    ['web/app/dogs/layout.tsx', 'web/app', 'layout', '/dogs'],
    ['web/app/api/dogs/route.ts', 'web/app', 'route', '/api/dogs'],
    ['web/src/pages/api/dogs/[id].ts', 'web/src/pages', 'pages-api', '/api/dogs/:id'],
    ['web/pages/api/index.js', 'web/pages', 'pages-api', '/api'],
  ])('finds %s', (path, root, kind, display) => {
    const route = nextRouteOf(path, ['web/next.config.ts']);
    expect(route).toMatchObject({ root, kind });
    expect(formatNextPath(route!.segments)).toBe(display);
  });

  it.each(['js', 'mjs', 'cjs', 'ts', 'mts'])('recognizes next.config.%s', extension => {
    expect(nextRouteOf('app/page.tsx', [`next.config.${extension}`])?.root).toBe('app');
  });

  it('preserves segment types and optional catch-all rather than comparing display strings', () => {
    expect(nextRouteOf('app/dogs/[id]/[[...slug]]/page.tsx', ['next.config.js'])?.segments)
      .toEqual([{ text: 'dogs' }, { param: 'id' }, { catchAll: 'slug', optional: true }]);
    expect(nextRouteOf('app/[...slug]/page.tsx', ['next.config.js'])?.segments).toEqual([{ catchAll: 'slug', optional: false }]);
  });

  it.each(['app/_components/page.tsx', 'app/_internal/route.ts', 'app/(..)photo/page.tsx',
    'app/(.)photo/page.tsx', 'app/(...)photo/page.tsx', 'app/(..)(..)photo/page.tsx',
    'app/%5Fprivate/page.tsx', 'app/dogs%20cats/layout.tsx', 'pages/api/_private/index.ts', 'app/component.tsx', 'app/route.tsx'])('does not invent a route for %s', path => {
    expect(nextRouteOf(path, ['next.config.ts'])).toBeNull();
  });

  it('requires exactly one configured root along the file path', () => {
    expect(nextRouteOf('web/app/page.tsx', [])).toBeNull();
    expect(nextRouteOf('web/app/page.tsx', ['other/next.config.ts'])).toBeNull();
    expect(nextRouteOf('web/app/nested/app/page.tsx', ['web/next.config.ts', 'web/app/nested/next.config.ts'])).toBeNull();
    expect(nextRouteOf('web/pages/api/pages/api/index.ts', ['web/next.config.ts', 'web/pages/api/next.config.ts'])).toBeNull();
    expect(nextRouteOf('web/app/page.tsx', ['web/next.config.ts', 'web/next.config.js'])?.root).toBe('web/app');
  });
});
