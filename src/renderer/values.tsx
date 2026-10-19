import React, { useState } from 'react';
import type { CallSite, FunctionCalls, NameValue, ValueSite } from '../shared/contracts';
import type { CallFunction } from './calls';
import { firstRows, Omitted } from './project-map';

const groups: { id: NameValue['group']; label: string }[] = [
  { id: 'parameter', label: '받는 값' }, { id: 'inside', label: '안에서 만든 이름' }, { id: 'outside', label: '바깥 이름' },
];
const roles: Record<NameValue['role'], string> = {
  parameter: '매개변수', const: 'const', let: 'let', var: 'var', for: '반복문(for … of/in)의 이름', catch: 'catch로 받는 이름', import: '가져온 이름',
  function: '함수(다른 값을 대입함)', other: '클래스·enum·namespace 같은 선언',
};
const initialLabels: Record<NonNullable<NameValue['initial']>['kind'], string> = {
  value: '처음 값', default: '넘기지 않으면 쓰는 값(기본값)', pattern: '구조 분해로 만든 이름(이름별 값은 계산하지 않아요)',
  loop: '반복할 때마다 꺼내는 값', export: '내보낼 때의 값(뒤의 대입은 가져오는 쪽에 반영되지 않아요)',
};

/** The argument a call passes at a parameter's position, or why it cannot be told. */
function argument(site: CallSite, index: number, hasDefault: boolean): React.ReactNode {
  if (!site.args) return <span className="hint">확인 못 함(태그 템플릿 호출이라 자리가 달라요)</span>;
  const spread = site.args.findIndex(item => item.spread);
  if (spread !== -1 && spread <= index) return <span className="hint">확인 못 함(펼침 인자로 자리를 정할 수 없어요)</span>;
  if (index >= site.args.length) return <span className="hint">넘기지 않음{hasDefault && ' · 기본값을 써요'}</span>;
  return <code>{site.args[index].text}</code>;
}

/**
 * Plan v2.3 V-1 in the flow view's function summary: the names the chosen function uses and what the code
 * writes for them. Values from running the code are never shown.
 */
export function ValuesFacts({ result, locked, pathOf, onShowSite, onShowFunction }: {
  result: FunctionCalls; locked: boolean; pathOf(fileId: string): string;
  onShowSite(site: ValueSite | CallSite): void; onShowFunction(target: CallFunction): void;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const value = chosen === null ? null : result.values[chosen];
  const showButton = (site: ValueSite | CallSite) =>
    <button className="btn btn--small" disabled={locked} onClick={() => onShowSite(site)}>코드 보기</button>;
  const at = (site: ValueSite | CallSite) => <span className="path">{pathOf(site.fileId)} {site.startLine}행</span>;
  return <>
    <dt>값 따라가기</dt>
    <dd>
      <p className="hint">실행한 값이 아니에요. 코드에 적힌 값과 식이에요.</p>
      {result.values.length === 0 && <p>값 따라가기로 볼 이름이 없어요.</p>}
      {groups.map(group => {
        const items = result.values.flatMap((item, index) => item.group === group.id ? [{ item, index }] : []);
        const twice = (name: string) => items.filter(other => other.item.name === name).length > 1;
        return items.length > 0 && <div key={group.id} role="group" aria-label={group.label} className="value-names">
          <span className="eyebrow">{group.label}</span>
          {firstRows(items).map(({ item, index }) => <button key={index} className="btn btn--small" aria-pressed={chosen === index} onClick={() => setChosen(index)}>
            {item.name}{twice(item.name) && item.declaredAt && ` (${item.declaredAt.startLine}행)`}</button>)}
          <Omitted count={items.length} />
        </div>;
      })}
      {value && <section className="value-card" aria-label={`${value.name} 값`}>
        <dl className="flow-facts">
          <dt>선언</dt>
          <dd>{roles[value.role]}{value.declaredAt && <> · {at(value.declaredAt)} {showButton(value.declaredAt)}</>}</dd>
          {value.unknown ? <><dt>값</dt><dd><span className="tag tag--unknown">확인 못 함</span>{value.unknown}</dd></>
            : value.external ? <><dt>값</dt><dd><span className="tag tag--doc">외부 패키지 또는 경로 별칭</span><code>{value.external}</code></dd></>
            : <>
              <dt>적힌 타입</dt><dd>{value.type ? <code>{value.type}</code> : '적힌 타입 없음'}</dd>
              {value.fixed !== null && <><dt>고정 값</dt><dd><code>{value.fixed}</code></dd></>}
              {value.role === 'catch' && <><dt>값</dt><dd>try 안에서 오류가 났을 때 받는 값이에요.</dd></>}
              {value.initial && <><dt>{initialLabels[value.initial.kind]}</dt><dd><code>{value.initial.text}</code> {at(value.initial)} {showButton(value.initial)}</dd></>}
              {value.fixed === null && <><dt>대입 · {value.assignments.length}개</dt><dd>
                {value.assignments.length ? <ul className="map-list" aria-label={`${value.name}에 대입하는 곳`}>
                  {firstRows(value.assignments).map(item => <li key={item.startUtf16}>{at(item)} <code>{item.text}</code> {showButton(item)}</li>)}
                </ul> : <p>이 선언에 대입하는 곳이 없어요.</p>}
                <Omitted count={value.assignments.length} />
              </dd></>}
              {value.group === 'parameter' && <Incoming value={value} result={result} at={at} showButton={showButton} />}
              {value.outerFunction && <><dt>들어오는 값</dt><dd>
                <p>바깥 함수({value.outerFunction.name})의 매개변수예요. 그 함수를 골라 들어오는 값을 보세요.</p>
                <button className="btn btn--small" disabled={locked} onClick={() => onShowFunction(value.outerFunction!)}>그 함수로</button>
              </dd></>}
            </>}
        </dl>
        {value.notes.map(note => <p key={note} className="hint">{note}</p>)}
      </section>}
    </dd>
  </>;
}

/** What the calls found pass at the chosen function's parameter, test files apart. */
function Incoming({ value, result, at, showButton }: {
  value: NameValue; result: FunctionCalls; at(site: CallSite): React.ReactNode; showButton(site: CallSite): React.ReactNode;
}) {
  const body = value.shape === 'rest' ? <p>나머지 매개변수라 자리를 정할 수 없어요(확인 못 함).</p>
    : value.shape === 'destructured' ? <p>구조 분해한 매개변수라 이름별 값을 정할 수 없어요(확인 못 함).</p>
    : value.index === null ? null
    : !result.callers ? <p>이름으로 불리지 않는 함수라 들어오는 값을 찾지 않았어요.</p>
    : !result.callers.length ? <p>이 함수로 이어진 부르는 곳이 없어 들어오는 값을 찾지 못했어요.</p>
    : <>{[false, true].map(inTest => {
      const sites = result.callers!.filter(site => site.inTest === inTest);
      return sites.length > 0 && <div key={String(inTest)}>
        <span className="eyebrow">{inTest ? '테스트 예시' : '부르는 곳에서 넘기는 값'}</span>
        <ul className="map-list" aria-label={inTest ? `${value.name} 테스트 예시` : `${value.name}에 넘기는 값`}>
          {firstRows(sites).map(site => <li key={`${site.fileId}:${site.startUtf16}`}>
            {at(site)} {argument(site, value.index!, value.initial?.kind === 'default')} {showButton(site)}
          </li>)}
        </ul>
        <Omitted count={sites.length} />
      </div>;
    })}<p className="hint">확정된 부르는 곳만 봐요. ‘이름이 같지만 잇지 못한 호출’의 인자는 넣지 않았어요.</p></>;
  return body && <><dt>들어오는 값</dt><dd>{body}</dd></>;
}
