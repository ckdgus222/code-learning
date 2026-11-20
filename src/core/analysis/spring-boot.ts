import { isMap, isScalar, Lexer, parseDocument, visit } from 'yaml';
import type { ProjectFile, Route } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { bootResource, javaModuleRoot } from '../project/spring-paths';
import { bounded } from './routes';

const contextPath = 'server.servlet.context-path';
const servletPath = 'spring.mvc.servlet.path';
const pathKeys = [contextPath, servletPath];
const conditional = '프로필이나 외부 설정에 따라 주소가 달라질 수 있어요.';
const unreadable = '설정 형식이나 값을 확인하지 못했어요.';
const incomplete = '설정 파일을 모두 읽지 못했어요.';
class UnknownSetting extends Error {}
type Prefix = { prefix: string; sources: string[] } | { reason: string };

function collect(key: string, value: unknown, values: Map<string, string>): void {
  // Relaxed binding can spell a property in several ways. Only the explicit supported spelling is evidence.
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  if (/^spring\.(?:profiles(?:\.|$)|config\.(?:activate|import|location|additionallocation|name)(?:\.|$))/.test(normalized))
    throw new UnknownSetting(conditional);
  if (!pathKeys.some(name => name.replace(/-/g, '') === normalized)) return;
  if (!pathKeys.includes(key) || typeof value !== 'string') throw new UnknownSetting(unreadable);
  if (values.has(key)) throw new UnknownSetting('같은 주소 설정이 여러 곳에 있어요.');
  if (value.includes('${')) throw new UnknownSetting('주소에 환경 변수 자리 표시자가 있어요.');
  if (value && (!/^\/(?:[\p{L}\p{M}\p{N}._~/-]*)$/u.test(value) || value.includes('//')
    || value.split('/').some(part => part === '.' || part === '..') || bounded(value) === null))
    throw new UnknownSetting(unreadable);
  values.set(key, value.replace(/\/$/, ''));
}

function readProperties(text: string, values: Map<string, string>): void {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index++) {
    if (/^[#!]---$/.test(lines[index])) throw new UnknownSetting(conditional);
    let line = lines[index].replace(/^[ \t\f]+/, '');
    if (!line || /^[#!]/.test(line)) continue;
    const parts: string[] = [];
    for (;;) {
      let end = line.length;
      while (end > 0 && line[end - 1] === '\\') end--;
      if ((line.length - end) % 2 === 0) break;
      parts.push(line.slice(0, -1));
      if (++index >= lines.length) throw new UnknownSetting(unreadable);
      line = lines[index].replace(/^[ \t\f]+/, '');
    }
    parts.push(line);
    const entry = /^([^ \t\f=:]*)[ \t\f]*[=:]?[ \t\f]*([\s\S]*)$/.exec(parts.join(''))!;
    if (entry[1].includes('\\')) throw new UnknownSetting(unreadable);
    collect(entry[1], entry[2], values);
  }
}

function readYaml(text: string, values: Map<string, string>): void {
  // Bound the composer's input, including flow collections on a single line, before building a tree.
  if (/^[ \t]{128}/m.test(text)) throw new UnknownSetting(unreadable);
  let tokens = 0, flowDepth = 0;
  for (const token of new Lexer().lex(text)) {
    if (token === '[' || token === '{') flowDepth++;
    if (token === ']' || token === '}') flowDepth--;
    if (++tokens > 8192 || flowDepth > 64) throw new UnknownSetting(unreadable);
  }
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: false, stringKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new UnknownSetting(unreadable);
  if (!doc.contents || isScalar(doc.contents) && doc.contents.source === '') return;
  if (!isMap(doc.contents)) throw new UnknownSetting(unreadable);
  // Validate duplicate keys in linear time, even in a section unrelated to the address.
  visit(doc, { Map(_key, map) {
    const keys = new Set<string>();
    for (const pair of map.items) {
      const key = pair.key;
      if (!isScalar(key) || key.tag || typeof key.value !== 'string' || keys.has(key.value))
        throw new UnknownSetting(unreadable);
      keys.add(key.value);
    }
  } });
  // Never convert to JS or expand aliases. Only inspect values in namespaces relevant to the prefix.
  function readMap(node: unknown, parent: string): void {
    if (!isMap(node) || node.tag) throw new UnknownSetting(unreadable);
    for (const { key, value } of node.items) {
      if (!isScalar<string>(key)) throw new UnknownSetting(unreadable);
      const name = key.value;
      if (name === '<<') throw new UnknownSetting(unreadable);
      const full = parent + name;
      collect(full, isScalar(value) && !value.tag ? value.value : undefined, values);
      if (!['server', 'server.servlet', 'spring', 'spring.mvc', 'spring.mvc.servlet', 'spring.config'].includes(full.toLowerCase())) continue;
      if (isMap(value)) readMap(value, full + '.');
      else if (value !== null) throw new UnknownSetting(unreadable);
    }
  }
  readMap(doc.contents, '');
}

type ReadConfig = (file: ProjectFile) => Promise<string>;

async function bootPrefix(files: ProjectFile[], read: ReadConfig): Promise<Prefix> {
  const values = new Map<string, string>();
  const sources: string[] = [];
  try {
    for (const file of files) {
      const text = await read(file);
      const found = new Map<string, string>();
      if (file.relativePath.endsWith('.properties')) readProperties(text, found);
      else readYaml(text, found);
      if (!found.size) continue;
      if (file.relativePath.split('/').at(-1)!.startsWith('application-')) throw new UnknownSetting(conditional);
      for (const [key, value] of found) collect(key, value, values);
      sources.push(file.relativePath);
    }
    return { prefix: (values.get(contextPath) ?? '') + (values.get(servletPath) ?? ''), sources };
  } catch (error) {
    if (error instanceof AppError && error.code === 'CANCELLED') throw error;
    return { reason: error instanceof UnknownSetting ? error.message : incomplete };
  }
}

/** Apply module-local settings once per module before the normal request matcher runs. */
export async function applyBootPrefixes(routes: Route[], files: ProjectFile[], applications: Set<string>,
  read: ReadConfig, notes: string[], check: () => void): Promise<void> {
  const configs = new Map<string, ProjectFile[]>();
  const rootsById = new Map<string, string>();
  const missing = new Set<string>();
  for (const file of files) {
    const resource = bootResource(file.relativePath);
    if (resource?.name) {
      const list = configs.get(resource.root) ?? [];
      list.push(file);
      configs.set(resource.root, list);
    }
    if (!/\.java$/i.test(file.relativePath)) continue;
    const root = javaModuleRoot(file.relativePath);
    if (root === null) continue;
    rootsById.set(file.id, root);
    if (file.bootSettingsIncomplete) missing.add(root);
  }
  const resolved = new Map<string, Prefix>();
  const reasons = new Set<string>();
  const sources = new Set<string>();
  let known = false;
  for (const route of routes) {
    if (route.framework !== 'spring') continue;
    check();
    const root = rootsById.get(route.handler.fileId);
    if (root === undefined || !applications.has(root)) {
      reasons.add('같은 모듈에서 Spring Boot 시작 클래스를 확인하지 못했어요.');
      continue;
    }
    let result = resolved.get(root);
    if (!result) {
      result = missing.has(root) ? { reason: incomplete } : await bootPrefix(configs.get(root) ?? [], read);
      resolved.set(root, result);
    }
    if ('reason' in result) { reasons.add(result.reason); continue; }
    if (route.unmatched || route.path === null) continue;
    const { prefix } = result;
    const path = bounded(prefix && route.path === '/' ? prefix : prefix + route.path);
    if (path === null) {
      route.path = null;
      route.unmatched = true;
      delete route.segments;
      reasons.add('설정을 합친 주소가 길이 한도를 넘었어요.');
      continue;
    }
    route.path = path;
    route.prefix = 'known';
    if (prefix && route.segments)
      route.segments = [...prefix.slice(1).split('/').map(text => ({ text })), ...route.segments];
    known = true;
    for (const source of result.sources) sources.add(source);
  }
  if (reasons.size) notes.push('Spring 주소의 앞부분을 확인하지 못해 추정으로 표시했어요. ' + [...reasons].join(' '));
  if (known) {
    notes.push('Spring Boot의 기본값 또는 설정 파일에서 주소 앞부분을 확인했어요. 환경 변수·실행 옵션·외부 설정에 따라 실제 주소는 달라질 수 있어요.');
    for (const source of sources) notes.push('Spring Boot 주소 설정: ' + source);
  }
}
