import React, { useEffect, useMemo, useState } from 'react';
import type { CodeStep, CodeSymbol, Evidence, LearningMark, MarkKey, SourceView } from '../shared/contracts';
import { functionCodeHash, markKeysOf, sameMarkKey, type MarkChange } from './marks';
import { MarkBadge, MarkEditor } from './learning-marks';

// Fixed wording for what each language construct does. It says nothing about what this
// project means by the code; that needs the AI explanation, which is not connected yet.
const doing: Record<string, string> = {
  if_statement: '조건이 맞는지 확인해요. 결과에 따라 다음에 갈 곳이 달라져요.',
  else_clause: '바로 앞 조건이 맞지 않을 때 이쪽으로 와요.',
  return_statement: '값을 돌려주려고 해요. 보통 여기서 함수가 끝나지만, 감싼 finally가 있으면 그 부분을 먼저 지나고 거기서 결과나 흐름이 바뀔 수 있어요.',
  // An arrow expression body cannot sit inside try/finally, so it always ends the function.
  expression_body: '식을 계산한 값을 돌려주고 이 함수가 끝나요.',
  // Which catch receives it depends on where the throw sits (a throw inside a catch skips that catch), so no order is claimed.
  throw_statement: '오류를 던져요. 이 오류를 어디서 받는지는 감싼 코드 구조에 따라 달라요. 받는 catch가 없으면 이 함수를 부른 곳으로 넘어가고, 그 과정에서 finally가 흐름을 바꿀 수 있어요.',
  lexical_declaration: '이름을 만들고, 값이 있으면 계산해서 담아 둬요.',
  variable_declaration: '이름을 만들고, 값이 있으면 계산해서 담아 둬요.',
  expression_statement: '식을 계산해요.',
  call_expression: '다른 함수를 불러요.',
  await_expression: '결과가 준비될 때까지 기다려요. 그동안 다른 작업이 먼저 처리될 수 있어요.',
  yield_expression: '값을 하나 내보내고, 다음 값을 달라고 할 때까지 멈춰요.',
  for_statement: '조건이 맞는 동안 안쪽 단계를 되풀이해요.',
  for_in_statement: '값이나 이름을 하나씩 꺼내며 안쪽 단계를 되풀이해요.',
  while_statement: '조건이 맞는 동안 안쪽 단계를 되풀이해요.',
  do_statement: '안쪽 단계를 먼저 한 번 지나고, 그 뒤 조건이 맞는 동안 되풀이해요.',
  switch_statement: '값과 같은 case가 있으면 그곳으로, 없으면 default가 있을 때 그곳으로 가요.',
  switch_case: 'switch 값이 이 case 값과 같으면 여기서 시작해요. 앞 case에서 break 없이 내려와도 여기를 지나요.',
  switch_default: '맞는 case가 없으면 여기서 시작해요. 앞 case에서 break 없이 내려와도 여기를 지나요.',
  try_statement: '안쪽 코드를 지나요. 오류가 나면 catch가 있을 때 그쪽으로 가고, finally가 있으면 마지막에 그 부분을 지나요.',
  catch_clause: '앞의 try 안에서 오류가 났을 때 여기로 와요.',
  finally_clause: '오류가 있든 없든 마지막에 여기를 지나요.',
  break_statement: '감싼 반복문이나 switch(이름표가 있으면 그 문장)를 빠져나가요.',
  continue_statement: '이번 회차를 끝내고 다음 반복으로 넘어가요.',
};
const detailLabels: Record<string, string> = {
  if_statement: '확인하는 조건', while_statement: '확인하는 조건', do_statement: '확인하는 조건', for_statement: '확인하는 조건',
  for_in_statement: '꺼내는 항목', switch_statement: '비교할 값', switch_case: 'case 값',
  return_statement: '돌려주는 값', throw_statement: '던지는 오류',
};
const loops = new Set(['for_statement', 'for_in_statement', 'while_statement', 'do_statement']);
const exitKinds = new Set(['return_statement', 'throw_statement', 'expression_body']);
const SNIPPET_LINES = 12;

interface FlowProps {
  source: SourceView | null;
  symbol: CodeSymbol | undefined;
  step: CodeStep | undefined;
  /** The evidence main has re-checked against the file; code is shown only when it matches the step. */
  evidence: Evidence | null;
  locked: boolean;
  onSymbol(symbol: CodeSymbol): void;
  /** null returns to the function summary. */
  onStep(step: CodeStep | null): void;
  onOpenCode(): void;
  /** What the chosen function calls and where it is called from (calls.tsx), shown in its summary. */
  calls: React.ReactNode;
  /** The project's learning records (plan v2.2 9.3), null until they are read; saving one locks it until main answers. */
  marks: LearningMark[] | null;
  pendingMarks: MarkKey[];
  onSaveMark(key: MarkKey, change: MarkChange, currentHash: string): void;
}

export function Flow({ source, symbol, step, evidence, locked, onSymbol, onStep, onOpenCode, calls, marks, pendingMarks, onSaveMark }: FlowProps) {
  const [hashes, setHashes] = useState<{ source: SourceView; values: Map<string, string> } | null>(null);
  const keys = useMemo(() => source ? markKeysOf(source) : new Map<string, MarkKey>(), [source]);
  const markOf = (item: CodeSymbol) => marks?.find(mark => sameMarkKey(mark, keys.get(item.id)!));
  useEffect(() => {
    if (!source) return;
    let active = true;
    // Only saved functions and the selected summary need a fingerprint.
    const needed = source.analysis.symbols.filter(item => item.id === symbol?.id || markOf(item));
    void Promise.all(needed.map(async item => [item.id, await functionCodeHash(source, item)] as const))
      .then(values => { if (active) setHashes({ source, values: new Map(values) }); })
      .catch(() => { if (active) setHashes(null); });
    return () => { active = false; };
  }, [source, symbol?.id, marks]);
  const hashOf = (item: CodeSymbol) => hashes?.source === source ? hashes.values.get(item.id) : undefined;
  if (!source) {
    return <div className="page page--empty">
      <h2 className="page__title">함수 안 순서</h2>
      <button className="btn" onClick={onOpenCode}>코드 읽기로 돌아가기</button>
      <p>왼쪽 목록에서 파일을 고르면, 그 파일의 함수를 한 단계씩 따라갈 수 있어요.</p>
    </div>;
  }
  const steps = symbol?.steps ?? [];
  const index = step ? steps.indexOf(step) : -1;

  return <div className="flow">
    <div className="flow__head">
      <h2 className="page__title">함수 안 순서</h2>
      <span className="path">{source.relativePath}</span>
      <button className="btn" onClick={onOpenCode}>코드 읽기로 돌아가기</button>
    </div>
    {source.analysis.warnings.map(message => <p key={message} className="hint flow__note">{message}</p>)}
    <div className="flow__body">
      <nav aria-label="함수와 단계" className="outline">
        <h3 className="eyebrow">함수</h3>
        {source.analysis.symbols.length === 0 && <p className="hint">이 파일에서 찾은 함수가 없어요.</p>}
        <ul className="symbols">{source.analysis.symbols.map(item => <li key={item.id}>
          <button className="symbols__item" aria-pressed={symbol?.id === item.id} disabled={locked}
            onClick={() => onSymbol(item)}>{item.name}</button>
          <MarkBadge mark={markOf(item)} currentHash={hashOf(item)} />
          {symbol?.id === item.id && <ol className="steps" aria-label={`${item.name} 단계`}>
            {item.steps.map((next, number) => <li key={next.id} style={{ paddingLeft: next.depth * 14 }}>
              <span className="steps__no" aria-hidden="true">{number + 1}</span>
              <button className="steps__item" aria-current={next === step ? 'step' : undefined} disabled={locked}
                onClick={() => onStep(next)}>{next.title}</button>
            </li>)}
          </ol>}
        </li>)}</ul>
      </nav>
      <section className="flow__main" aria-label="현재 위치">
        {!symbol ? <p className="hint">따라갈 함수를 왼쪽에서 골라 주세요.</p>
          : !step ? <Summary symbol={symbol} source={source} locked={locked} onStep={onStep} calls={calls}
            learningMark={<MarkEditor key={`${source.fileId}:${symbol.id}`} mark={markOf(symbol)} currentHash={hashOf(symbol)}
              locked={locked || marks === null || pendingMarks.some(key => sameMarkKey(key, keys.get(symbol.id)!))}
              onSave={change => { const hash = hashOf(symbol); if (hash) onSaveMark(keys.get(symbol.id)!, change, hash); }} />} />
          : <article className="flow-card" aria-label="현재 단계">
            <div className="flow-card__top">
              <span className="eyebrow">{index + 1} / {steps.length} 단계 · {symbol.name}</span>
              <span className="tag tag--ok">코드 구조에서 확인됨</span>
            </div>
            <h3>{step.title}</h3>
            <dl className="flow-facts">
              <dt>지금 하는 일</dt>
              <dd>{step.kind === 'return_statement' && !step.detail
                ? '돌려주는 값 없이 함수를 끝내려고 해요. 감싼 finally가 있으면 그 부분을 먼저 지나고 거기서 결과나 흐름이 바뀔 수 있어요.'
                : doing[step.kind] ?? '이 부분의 코드를 지나요.'}</dd>
              {step.detail && <><dt>{detailLabels[step.kind] ?? '코드'}</dt><dd><code>{step.detail}</code></dd></>}
              {step.branch && <>
                <dt>맞으면</dt><dd><Target id={step.branch.whenTrue} steps={steps} locked={locked} onStep={onStep} /></dd>
                <dt>아니면</dt><dd><Target id={step.branch.whenFalse} steps={steps} locked={locked} onStep={onStep} /></dd>
              </>}
              {loops.has(step.kind) && <><dt>주의</dt><dd>{step.kind === 'do_statement'
                ? '안쪽에는 적어도 한 번 들어가요. 그 뒤 몇 번 더 도는지는 코드만으로 알 수 없어요.'
                : '안쪽을 몇 번 도는지는 코드만으로 알 수 없어요. 한 번도 안 돌 수도 있어요.'} 안쪽 조건에 따라 일부 단계는 건너뛸 수 있어요.</dd></>}
              {step.kind === 'call_expression' && <><dt>주의</dt><dd>부른 함수의 안쪽은 현재 코드만으로 연결을 확인하지 못했어요.</dd></>}
            </dl>
            {evidence?.id === step.evidence.id
              ? <Snippet source={source} evidence={evidence} />
              : <p className="hint">근거 위치를 확인하지 못했어요. 코드가 바뀌었다면 왼쪽에서 파일을 다시 골라 읽어 주세요.</p>}
            <div className="flow-nav">
              <button className="btn" disabled={locked} onClick={() => onStep(steps[index - 1] ?? null)}>이전 단계</button>
              <button className="btn btn--primary" disabled={locked || index === steps.length - 1} onClick={() => onStep(steps[index + 1])}>다음 단계</button>
              <button className="btn" disabled={locked || evidence?.id !== step.evidence.id} onClick={onOpenCode}>코드 크게 보기</button>
            </div>
          </article>}
      </section>
    </div>
  </div>;
}

function Summary({ symbol, source, locked, onStep, calls, learningMark }: {
  symbol: CodeSymbol; source: SourceView; locked: boolean; onStep(step: CodeStep): void; calls: React.ReactNode; learningMark: React.ReactNode;
}) {
  // Where the code returns or throws. Whether the function really ends there is not checked.
  const exits = symbol.steps.filter(item => exitKinds.has(item.kind));
  return <article className="flow-card" aria-label="함수 요약">
    <div className="flow-card__top">
      <span className="eyebrow">{source.relativePath} · {symbol.evidence.startLine}–{symbol.evidence.endLine}줄</span>
      <span className="tag tag--ok">코드 구조에서 확인됨</span>
    </div>
    <h3>{symbol.name}</h3>
    <dl className="flow-facts">
      <dt>받는 값</dt>
      <dd>{symbol.params && symbol.params !== '()' ? <code>{symbol.params}</code> : '받는 값이 없어요.'}</dd>
      <dt>돌려주거나 오류를 던지는 곳</dt>
      <dd>
        {exits.length > 0 ? <ul className="flow-exits">{exits.map(item => <li key={item.id}>
          <button className="flow-link" disabled={locked} onClick={() => onStep(item)}>
            {symbol.steps.indexOf(item) + 1}. {item.title}</button>
          {item.detail && <code>{item.detail}</code>}
        </li>)}</ul> : <p>코드에서 찾은 반환·오류 던지기가 없어요.</p>}
        <p className="hint">함수가 실제로 어디서 끝나는지는 확인하지 않았어요. try 안에서 던진 오류는 catch로 이어질 수 있고, finally가 결과를 바꿀 수 있고, 마지막 줄까지 내려와 끝날 수도 있어요.</p>
      </dd>
      {calls}
      <dt>하는 일</dt>
      <dd><span className="tag tag--unknown">확인하지 못함</span>AI 설명 연결 전이라 이 함수가 왜 있는지는 아직 확인하지 못했어요.</dd>
    </dl>
    {learningMark}
    <p className="hint">코드에 적힌 순서대로 한 단계씩 보여줘요. 실제로는 조건에 따라 건너뛰거나 되풀이하는 단계가 있어요.</p>
    <div className="flow-nav">
      <button className="btn btn--primary" disabled={locked || symbol.steps.length === 0} onClick={() => onStep(symbol.steps[0])}>다음 단계</button>
    </div>
  </article>;
}

function Target({ id, steps, locked, onStep }: { id: string | null; steps: CodeStep[]; locked: boolean; onStep(step: CodeStep): void }) {
  const target = steps.find(item => item.id === id);
  if (!target) return <span className="hint">다음 연결을 확인하지 못했어요.</span>;
  return <button className="flow-link" disabled={locked} onClick={() => onStep(target)}>
    {steps.indexOf(target) + 1}. {target.title}</button>;
}

/** Original text of the checked range with its own line numbers; display only, offsets are untouched. */
export function Snippet({ source, evidence, more = '코드 크게 보기' }: {
  source: SourceView; evidence: Pick<Evidence, 'startUtf16' | 'endUtf16' | 'startLine' | 'endLine'>; more?: string;
}) {
  // Start at the beginning of the first line when only indentation precedes the range,
  // so the first line lines up with the rest.
  const lineStart = source.text.lastIndexOf('\n', evidence.startUtf16 - 1) + 1;
  const from = /^\s*$/.test(source.text.slice(lineStart, evidence.startUtf16)) ? lineStart : evidence.startUtf16;
  const lines = source.text.slice(from, evidence.endUtf16).split('\n').map(line => line.replace(/\r$/, ''));
  const hidden = lines.length - SNIPPET_LINES;
  return <figure className="snippet">
    <figcaption>{source.relativePath} · {evidence.startLine}–{evidence.endLine}줄</figcaption>
    <pre data-testid="flow-snippet">{lines.slice(0, SNIPPET_LINES).map((line, offset) => <span key={offset} className="snippet__line">
      <span className="snippet__no" aria-hidden="true">{evidence.startLine + offset}</span>{line}{'\n'}
    </span>)}</pre>
    {hidden > 0 && <p className="hint snippet__more">이어지는 {hidden}줄은 ‘{more}’에서 볼 수 있어요.</p>}
  </figure>;
}
