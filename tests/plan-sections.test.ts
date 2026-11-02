import { expect, it } from 'vitest';
import { planSections } from '../src/core/analysis/plan-sections';
import { SECRET_MASK } from '../src/core/ai/secrets';

it('keeps preamble separate and includes child ranges in their parent', () => {
  const text = '소개\n# 큰 장\n본문\n### 작은 절\n내용\n## 다음 절\n끝\n# 다음 장';
  const result = planSections(text);
  expect(result.lines).toBe(8);
  expect(result.sections).toEqual([
    { id: 's1', title: '(제목 앞 내용)', level: 0, startLine: 1, endLine: 1, bytes: Buffer.byteLength('소개\n'), parentId: null },
    { id: 's2', title: '큰 장', level: 1, startLine: 2, endLine: 7,
      bytes: Buffer.byteLength('# 큰 장\n본문\n### 작은 절\n내용\n## 다음 절\n끝\n'), parentId: null },
    { id: 's4', title: '작은 절', level: 3, startLine: 4, endLine: 5, bytes: Buffer.byteLength('### 작은 절\n내용\n'), parentId: 's2' },
    { id: 's6', title: '다음 절', level: 2, startLine: 6, endLine: 7, bytes: Buffer.byteLength('## 다음 절\n끝\n'), parentId: 's2' },
    { id: 's8', title: '다음 장', level: 1, startLine: 8, endLine: 8, bytes: Buffer.byteLength('# 다음 장'), parentId: null },
  ]);
});

it.each(['```', '~~~'])('ignores headings inside %s fences, including misleading closing fences', fence => {
  const other = fence[0] === '`' ? '~~~' : '```';
  const text = ['# visible', `   ${fence}${fence[0]}lang`, '# hidden1', other, '# hidden2', fence, '# hidden3',
    `    ${fence}${fence[0]}`, '# hidden4', `${fence}${fence[0]} trailing`, '# hidden5', `${fence}${fence[0]}  `,
    '## visible child', fence, '# unclosed'].join('\n');
  expect(planSections(text).sections.map(section => section.title)).toEqual(['visible', 'visible child']);
});

it('counts Korean, emoji, CRLF and the trailing empty line without normalizing the text', () => {
  const result = planSections('# 한국어\r\n내용 📦\r\n');
  expect(result.lines).toBe(3);
  expect(result.lineBytes).toEqual([13, 13, 0]);
  expect(result.sections[0]).toMatchObject({ startLine: 1, endLine: 3, bytes: 26 });
});

it('does not invent ATX headings for Setext, indented headings or missing whitespace', () => {
  const text = '제목\n===\n소제목\n---\n # 들여쓰기\n#공백없음\n####### 일곱\n본문';
  expect(planSections(text).sections).toEqual([
    { id: 's1', title: '(제목 앞 내용)', level: 0, startLine: 1, endLine: 8, bytes: Buffer.byteLength(text), parentId: null },
  ]);
  expect(planSections('')).toEqual({ lines: 1, lineBytes: [0], sections: [] });
});

it('masks secrets in displayed titles without changing the original byte count', () => {
  const text = '# password: example-only-value\n## apiKey = "test-only-value"\n';
  const result = planSections(text);
  expect(result.sections.map(section => section.title)).toEqual([`password: ${SECRET_MASK}`, `apiKey = "${SECRET_MASK}"`]);
  expect(result.sections[0].bytes).toBe(Buffer.byteLength(text));
  expect(JSON.stringify(result.sections)).not.toContain('example-only-value');
});
