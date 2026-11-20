import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findProjectRoutes, ROUTE_LIMITS } from '../src/core/analysis/routes';
import { buildFeatureFlow } from '../src/core/analysis/feature-flow';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import { MAX_FILE_BYTES, scanProject } from '../src/core/project/files';

const bootPackage = 'org.springframework.boot.autoconfigure';
const application = `import ${bootPackage}.SpringBootApplication;\n@SpringBootApplication\nclass Application {}`;
const controller = 'import org.springframework.web.bind.annotation.*;\n@RestController\nclass OrderController {\n@GetMapping("/orders")\nString orders() { return helper(); }\nString helper() { return "ok"; }\n}';
const java = 'src/main/java/example';
const resources = 'src/main/resources';
const config = `${resources}/application.yml`;
const request = "export function load() { return fetch('/api/v1/orders'); }";
const moduleFiles = (prefix = '') => ({
  [`${prefix}${java}/Application.java`]: application,
  [`${prefix}${java}/OrderController.java`]: controller,
});

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function project(entries: Record<string, string>) {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-boot-')));
  for (const [name, text] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return (await scanProject(root, 'p')).files;
}
async function analyze(entries: Record<string, string> = {}) {
  const files = await project({ ...moduleFiles(), 'web/api.ts': request, ...entries });
  return findProjectRoutes(root, 'p', files);
}

describe('Spring Boot configuration and requests', () => {
  it.each([
    ['equals', 'properties', 'server.servlet.context-path=/api/\nspring.mvc.servlet.path=/v1/'],
    ['colon', 'properties', 'server.servlet.context-path: /api\nspring.mvc.servlet.path: /v1'],
    ['whitespace', 'properties', 'server.servlet.context-path /api\nspring.mvc.servlet.path\t/v1'],
    ['comments and continuation', 'properties', '# heading\n! ignored\nserver.servlet.context-path=/a\\\n  pi\nspring.mvc.servlet.path=/v1'],
    ['nested YAML', 'yml', 'server:\n  servlet:\n    context-path: /api\nspring:\n  mvc:\n    servlet:\n      path: /v1\n'],
    ['dotted YAML', 'yaml', 'server.servlet.context-path: /api\nspring.mvc.servlet.path: /v1'],
    ['mixed YAML', 'yml', 'server.servlet:\n  context-path: /api\nspring.mvc:\n  servlet.path: /v1'],
  ])('joins both settings from %s and links only the complete request', async (_name, extension, text) => {
    const relativePath = `${resources}/application.${extension}`;
    const result = await analyze({ [relativePath]: text,
      'web/api.ts': request + "\nfetch('/orders'); fetch('/wrong/orders');" });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/api/v1/orders', prefix: 'known',
      segments: [{ text: 'api' }, { text: 'v1' }, { text: 'orders' }] });
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({ sure: true, reasons: [] });
    expect(result.requests[result.links[0].requestIndex].path).toBe('/api/v1/orders');
    expect(result.prefix).toBeNull();
    expect(result.notes.join('\n')).toContain(relativePath);
    expect(result.notes.join('\n')).toMatch(/환경 변수.*실행 옵션/);
    expect(await readFile(path.join(root, relativePath), 'utf8')).toBe(text);
  });

  it.each([
    ['no settings', {}, '/orders'],
    ['unrelated settings', { [config]: 'server.port: 8080\n' }, '/orders'],
    ['empty YAML', { [config]: '' }, '/orders'],
    ['root settings', { [config]: 'server.servlet.context-path: /\nspring.mvc.servlet.path: /' }, '/orders'],
    ['context only', { [config]: 'server.servlet.context-path: /api' }, '/api/orders'],
    ['servlet only', { [config]: 'spring.mvc.servlet.path: /api' }, '/api/orders'],
  ])('uses omitted key defaults for %s', async (_name, settings, address) => {
    const result = await analyze({ ...settings, 'web/api.ts': `fetch('${address}');` });
    expect(result.routes[0]).toMatchObject({ path: address, prefix: 'known' });
    expect(result.links).toHaveLength(1);
    expect(result.links[0].sure).toBe(true);
  });

  it('combines distinct keys from separate base files', async () => {
    const result = await analyze({ [config]: 'server.servlet.context-path: /api',
      [`${resources}/application.properties`]: 'spring.mvc.servlet.path=/v1' });
    expect(result.routes[0]).toMatchObject({ path: '/api/v1/orders', prefix: 'known' });
    expect(result.links[0].sure).toBe(true);
  });

  it('keeps modules independent when one module has an uncertain profile', async () => {
    const files = await project({ ...moduleFiles('one/'), ...moduleFiles('two/'),
      [`one/${config}`]: 'server.servlet.context-path: /one',
      [`two/${config}`]: 'server.servlet.context-path: /two',
      [`two/${resources}/application-prod.yml`]: 'server.servlet.context-path: /production',
      'web/api.ts': "fetch('/one/orders'); fetch('/two/orders');" });
    const result = await findProjectRoutes(root, 'p', files);
    const byFile = new Map(result.routes.map(route => [files.find(file => file.id === route.handler.fileId)!.relativePath, route]));
    expect(byFile.get(`one/${java}/OrderController.java`)).toMatchObject({ path: '/one/orders', prefix: 'known' });
    expect(byFile.get(`two/${java}/OrderController.java`)).toMatchObject({ path: '/orders', prefix: 'unknown' });
    expect(result.prefix).toBeNull();
  });

  it('matches each configured module to its own complete request', async () => {
    const files = await project({ ...moduleFiles('one/'), ...moduleFiles('two/'),
      [`one/${config}`]: 'server.servlet.context-path: /one',
      [`two/${config}`]: 'server.servlet.context-path: /two',
      'web/api.ts': "fetch('/one/orders'); fetch('/two/orders'); fetch('/orders');" });
    const result = await findProjectRoutes(root, 'p', files);
    expect(result.links).toHaveLength(2);
    for (const link of result.links) {
      const route = result.routes[link.routeIndex];
      expect(link.sure).toBe(true);
      expect(result.requests[link.requestIndex].path).toBe(route.path);
      const file = files.find(file => file.id === route.handler.fileId)!;
      expect(route.path).toBe(`/${file.relativePath.split('/')[0]}/orders`);
    }
  });

  it('does not borrow an application or settings from a sibling module', async () => {
    const files = await project({ [`one/${java}/Application.java`]: application,
      [`one/${config}`]: 'server.servlet.context-path: /one',
      [`two/${java}/OrderController.java`]: controller,
      [`two/${config}`]: 'server.servlet.context-path: /two', 'web/api.ts': "fetch('/two/orders');" });
    const result = await findProjectRoutes(root, 'p', files);
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
    expect(result.links[0].sure).toBe(false);
  });

  it('keeps the original handler evidence and stops the flow at Java', async () => {
    const files = await project({ ...moduleFiles(), [config]: 'server.servlet.context-path: /api\nspring.mvc.servlet.path: /v1',
      'web/api.ts': request });
    const result = await findProjectRoutes(root, 'p', files);
    const flow = await buildFeatureFlow(root, 'p', files, result, 0);
    expect(flow.nodes.filter(node => node.side === 'back').map(node => node.name)).toEqual(['OrderController.orders']);
    expect(flow.edges.filter(edge => edge.kind === 'route')).toHaveLength(1);
    expect(flow.edges.find(edge => edge.kind === 'route')!.sure).toBe(true);
    const handler = flow.nodes.find(node => node.side === 'back')!;
    expect(controller.slice(handler.range.startUtf16, handler.range.endUtf16)).toBe('@GetMapping("/orders")\nString orders() { return helper(); }');
    await writeFile(path.join(root, `${java}/OrderController.java`), controller + '\n// changed');
    await expect(buildFeatureFlow(root, 'p', files, result, 0)).rejects.toMatchObject({ code: 'CHANGED' });
  });

  it.each(['params="id"', 'headers="X-Mode=full"', 'consumes="application/json"', 'produces="application/json"', 'version="1"'])
    ('keeps a request conditional on %s uncertain even with a known Boot prefix', async condition => {
      const conditionalController = controller.replace('@GetMapping("/orders")', `@GetMapping(path="/orders", ${condition})`);
      const result = await analyze({ [`${java}/OrderController.java`]: conditionalController,
        [config]: 'server.servlet.context-path: /api\nspring.mvc.servlet.path: /v1' });
      expect(result.routes[0]).toMatchObject({ prefix: 'known', path: '/api/v1/orders' });
      expect(result.links).toHaveLength(1);
      expect(result.links[0].sure).toBe(false);
      expect(result.links[0].reasons.length).toBeGreaterThan(0);
    });

  it('links a root mapping using the configured prefix', async () => {
    const result = await analyze({ [`${java}/OrderController.java`]: controller.replace('"/orders"', '"/"'),
      [config]: 'server.servlet.context-path: /api', 'web/api.ts': "fetch('/api');" });
    expect(result.routes[0]).toMatchObject({ prefix: 'known', path: '/api', segments: [{ text: 'api' }] });
    expect(result.links[0].sure).toBe(true);
  });
});

describe('Spring Boot uncertainty boundaries', () => {
  it.each([
    ['placeholder YAML', { [config]: 'server.servlet.context-path: ${CONTEXT_PATH:/api}' }],
    ['placeholder properties', { [`${resources}/application.properties`]: 'server.servlet.context-path=${CONTEXT_PATH:/api}' }],
    ['profile path', { [`${resources}/application-prod.yml`]: 'server.servlet.context-path: /prod' }],
    ['profile servlet path', { [`${resources}/application-prod.properties`]: 'spring.mvc.servlet.path=/prod' }],
    ['invalid profile', { [`${resources}/application-prod.yml`]: 'server: [invalid' }],
    ['activation profile', { [config]: 'spring.config.activate.on-profile: prod\nserver.servlet.context-path: /api' }],
    ['legacy profile', { [config]: 'spring:\n  profiles: prod\nserver.servlet.context-path: /api' }],
    ['two documents', { [config]: 'server.servlet.context-path: /api\n---\nserver.port: 8080' }],
    ['invalid YAML', { [config]: 'server: [invalid' }],
    ['numeric path', { [config]: 'server.servlet.context-path: 42' }],
    ['null path', { [config]: 'server.servlet.context-path: null' }],
    ['sequence path', { [config]: 'server.servlet.context-path: [/api]' }],
    ['duplicate YAML keys', { [config]: 'server.servlet.context-path: /api\nserver.servlet.context-path: /other' }],
    ['invalid nested map elsewhere in the document', { [config]: 'logging:\n  level: INFO\n  level: DEBUG\nserver.servlet.context-path: /api' }],
    ['nested and dotted duplicate', { [config]: 'server.servlet.context-path: /api\nserver:\n  servlet:\n    context-path: /other' }],
    ['duplicate files', { [config]: 'server.servlet.context-path: /api', [`${resources}/application.properties`]: 'server.servlet.context-path=/api' }],
    ['duplicate properties keys', { [`${resources}/application.properties`]: 'server.servlet.context-path=/api\nserver.servlet.context-path=/other' }],
    ['aliased path', { [config]: 'base: &base /api\nserver.servlet.context-path: *base' }],
    ['merged settings', { [config]: 'defaults: &defaults\n  context-path: /api\nserver:\n  servlet:\n    <<: *defaults' }],
    ['escaped properties key', { [`${resources}/application.properties`]: 'server.servlet.context\\u002dpath=/api' }],
    ['escaped properties value', { [`${resources}/application.properties`]: 'server.servlet.context-path=/\\u0061pi' }],
    ['wildcard path', { [config]: 'server.servlet.context-path: /api/*' }],
    ['parameter path', { [config]: 'server.servlet.context-path: /api/{id}' }],
  ])('keeps the original route as a guess for %s', async (_name, settings) => {
    const result = await analyze(settings);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({ sure: false, reasons: expect.arrayContaining(['앞부분 모름']) });
  });

  it('allows a profile that only changes unrelated settings', async () => {
    const result = await analyze({ [config]: 'server.servlet.context-path: /api\nspring.mvc.servlet.path: /v1',
      [`${resources}/application-prod.yml`]: 'server.port: 9090' });
    expect(result.routes[0]).toMatchObject({ prefix: 'known', path: '/api/v1/orders' });
    expect(result.links[0].sure).toBe(true);
  });

  it.each([
    ['missing import', '@SpringBootApplication class Application {}'],
    ['wrong import', 'import other.SpringBootApplication; @SpringBootApplication class Application {}'],
    ['static import', `import static ${bootPackage}.SpringBootApplication; @SpringBootApplication class Application {}`],
    ['local shadow', application + '\n@interface SpringBootApplication {}'],
    ['comment only', '// @SpringBootApplication\nclass Application {}'],
    ['method annotation', `import ${bootPackage}.*; class Application { @SpringBootApplication void run() {} }`],
  ])('requires a real Boot application for %s', async (_name, source) => {
    const result = await analyze({ [`${java}/Application.java`]: source, [config]: 'server.servlet.context-path: /api' });
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
  });

  it.each([
    `import ${bootPackage}.*; @SpringBootApplication class Application {}`,
    `@${bootPackage}.SpringBootApplication class Application {}`,
  ])('accepts official wildcard and qualified annotations: %s', async source => {
    const result = await analyze({ [`${java}/Application.java`]: source,
      [config]: 'server.servlet.context-path: /api\nspring.mvc.servlet.path: /v1' });
    expect(result.links[0].sure).toBe(true);
  });

  it('detects same-name types in another listed Java file', async () => {
    const result = await analyze({ 'other/SpringBootApplication.java': 'public @interface SpringBootApplication {}',
      [config]: 'server.servlet.context-path: /api' });
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
  });

  it('keeps controllers outside the standard source tree uncertain', async () => {
    const files = await project({ 'Application.java': application, 'OrderController.java': controller,
      [config]: 'server.servlet.context-path: /api', 'web/api.ts': "fetch('/api/orders');" });
    const result = await findProjectRoutes(root, 'p', files);
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
  });

  it.each(['application.yml', 'application-prod.yml'])('does not treat an oversized %s as absent', async name => {
    const result = await analyze({ [`${resources}/${name}`]: 'server.servlet.context-path: /api\n#' + 'x'.repeat(MAX_FILE_BYTES) });
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
    expect(result.links[0].sure).toBe(false);
  });

  it.each([`${resources}/application.yml`, `${resources}/application-prod.yml`, `${resources}/`])('does not infer defaults through an ignored %s', async ignored => {
    const result = await analyze({ '.gitignore': ignored + '\n',
      [config]: 'server.servlet.context-path: /api', [`${resources}/application-prod.yml`]: 'server.servlet.context-path: /prod' });
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
    expect(result.links[0].sure).toBe(false);
  });

  it('keeps a removed registered setting uncertain', async () => {
    const files = await project({ ...moduleFiles(), [config]: 'server.servlet.context-path: /api', 'web/api.ts': request });
    await rm(path.join(root, config));
    const result = await findProjectRoutes(root, 'p', files);
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
  });

  it('rejects a setting replaced with a symbolic link after scanning', async () => {
    const files = await project({ ...moduleFiles(), [config]: 'server.servlet.context-path: /api',
      'unrelated.txt': 'server.servlet.context-path: /unexpected', 'web/api.ts': request });
    await rm(path.join(root, config));
    await symlink(path.join(root, 'unrelated.txt'), path.join(root, config));
    const result = await findProjectRoutes(root, 'p', files);
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
  });

  it('does not infer empty settings through a linked resources directory', async () => {
    await project({ ...moduleFiles(), 'other/application.yml': 'server.servlet.context-path: /api', 'web/api.ts': request });
    await symlink(path.join(root, 'other'), path.join(root, resources), 'dir');
    const files = (await scanProject(root, 'p')).files;
    const result = await findProjectRoutes(root, 'p', files);
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
    expect(result.links[0].sure).toBe(false);
  });

  it('does not expose malformed setting contents in result notes', async () => {
    const secret = 'private-value-never-in-notes';
    const result = await analyze({ [config]: `server: [${secret}` });
    expect(result.routes[0].prefix).toBe('unknown');
    expect(result.notes.join('\n')).not.toContain(secret);
  });

  it('shares the file budget with configuration and honors cancellation', async () => {
    const files = await project({ ...moduleFiles(), [config]: 'server.servlet.context-path: /api', 'web/api.ts': request });
    const result = await findProjectRoutes(root, 'p', files, { ...MAP_LIMITS, files: 3 });
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
    expect(result.limited).toBe(true);
    await expect(findProjectRoutes(root, 'p', files, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('counts configuration bytes in the shared byte budget', async () => {
    const files = await project({ ...moduleFiles(), [config]: 'server.servlet.context-path: /api', 'web/api.ts': request });
    const bytes = files.reduce((total, file) => total + file.size, 0) - 1;
    const result = await findProjectRoutes(root, 'p', files, { ...MAP_LIMITS, bytes });
    expect(result.routes[0]).toMatchObject({ path: '/orders', prefix: 'unknown' });
    expect(result.limited).toBe(true);
  });

  it('does not link a path beyond the joined path limit', async () => {
    const prefix = '/' + 'x'.repeat(ROUTE_LIMITS.pathLength - 2);
    const result = await analyze({ [config]: `server.servlet.context-path: ${prefix}` });
    expect(result.routes).toHaveLength(1);
    expect(result.links).toEqual([]);
  });
});
