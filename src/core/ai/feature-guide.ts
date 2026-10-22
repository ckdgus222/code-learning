import type { FeatureGuide } from '../../shared/ai';
import type { ProjectFiles, ProjectRoutes } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { formatNextPath, nextRouteOf } from '../analysis/next-routes';
import { maskSecrets } from './secrets';

export const MAX_FEATURE_GUIDE_BYTES = 32 * 1024;
/**
 * A name that is only letters, digits and the analyzer's own labels (`Class.method`, `onClick 함수 (5행)`). A computed
 * member name carries its expression, which is code the consent says is not sent, so anything else is replaced.
 */
const plainName = /^[\p{L}\p{N}_$#. ()]+$/u;
const sendableName = (name: string) => plainName.test(name) ? name : '이름 미확인';
export interface FeatureGuideMaterial {
  projectName: string;
  routes: { index: number; method: string; path: string | null; handler: string; file: string }[];
  requests: { index: number; path: string; methods: string[] | null; inFunction: string | null; file: string;
    links: { routeIndex: number; sure: boolean }[] }[];
  screens: { file: string; path: string }[];
}
/** A route list rather than files: it stays current while that list is the session's latest for this folder state. */
export interface FeatureGuideSnapshot { projectId: string; revision: number; routesId: string; material: FeatureGuideMaterial; limitations: string[] }

/** Only explicit metadata fields leave the session; source, README and analyzer snippets are never copied. */
export function featureGuideMaterial(project: ProjectFiles, routes: ProjectRoutes): { material: FeatureGuideMaterial; limitations: string[] } {
  let masked = 0;
  const safe = (value: string, limit: number) => {
    const result = maskSecrets(value);
    masked += result.count;
    return result.text.slice(0, limit);
  };
  const paths = project.files.map(file => file.relativePath);
  const pathById = new Map(project.files.map(file => [file.id, file.relativePath]));
  const material: FeatureGuideMaterial = { projectName: safe(project.name, 200), routes: [], requests: [], screens: [] };
  const limitations = ['주소·파일 경로·함수 이름 목록만 보고 쓴 정리예요. 코드 원문과 README 소개는 보내지 않았어요.'];
  // Account for the whole serialized object, including JSON punctuation and multibyte names.
  let bytes = Buffer.byteLength(JSON.stringify(material));
  let limited = false;
  const append = <T>(list: T[], item: T): boolean => {
    const extra = Buffer.byteLength(JSON.stringify(item)) + (list.length ? 1 : 0);
    if (bytes + extra > MAX_FEATURE_GUIDE_BYTES) { limited = true; return false; }
    bytes += extra; list.push(item); return true;
  };
  for (const [index, route] of routes.routes.entries()) {
    if (!append(material.routes, { index, method: route.method, path: route.path === null ? null : safe(route.path, 300),
      handler: safe(sendableName(route.handler.name), 200), file: safe(pathById.get(route.handler.fileId) ?? '', 300) })) break;
  }
  const allowed = new Set(material.routes.map(route => route.index));
  const links = new Map<number, FeatureGuideMaterial['requests'][number]['links']>();
  for (const link of routes.links) {
    if (allowed.has(link.routeIndex)) {
      const list = links.get(link.requestIndex) ?? [];
      list.push({ routeIndex: link.routeIndex, sure: link.sure }); links.set(link.requestIndex, list);
    }
  }
  for (const [index, request] of routes.requests.entries()) {
    if (!append(material.requests, { index, path: safe(request.path, 300), methods: request.methods?.map(method => safe(method, 200)) ?? null,
      inFunction: request.inFunction ? safe(sendableName(request.inFunction.name), 200) : null,
      file: safe(pathById.get(request.fileId) ?? '', 300), links: links.get(index) ?? [] })) break;
  }
  for (const file of project.files) {
    if (!/\/page\.(?:tsx|jsx|ts|js)$/.test(file.relativePath)) continue;
    const screen = nextRouteOf(file.relativePath, paths);
    if (screen?.kind === 'page' && !append(material.screens, { file: safe(file.relativePath, 300), path: safe(formatNextPath(screen.segments), 300) })) break;
  }
  if (limited) limitations.push('일부만 보냄: 자료가 32 KiB를 넘어 목록 순서대로 잘랐어요.');
  if (routes.limited) limitations.push('주소 분석의 상한으로 일부 주소·요청만 찾았어요.');
  if (masked) limitations.push('비밀값처럼 보이는 부분을 가린 뒤 보냈어요. 모든 비밀값을 찾는다고 보장하지는 않아요.');
  return { material, limitations };
}

export function checkFeatureGuideRoutes(guide: FeatureGuide, allowed: readonly number[]): void {
  const remaining = new Set(allowed);
  for (const group of guide.groups) for (const feature of group.features) for (const index of feature.routes) {
    if (!Number.isInteger(index) || !remaining.delete(index)) {
      throw new AppError('AI_RESPONSE', 'AI 정리에 보내지 않은 주소 번호나 중복된 주소가 있어 표시하지 않았어요.');
    }
  }
}
