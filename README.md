# Code Learning

로컬 프로젝트를 읽기 전용으로 살펴보는 독립 macOS 앱입니다. **현재는 구현 착수본이며, 개인용 시제품 완료 상태가 아닙니다.** 기준은 상위 폴더의 `universal-code-learning-implementation-plan-v2.2.md`입니다.

## 현재 가능한 일

- 폴더 선택 → 제외 이유·파일 목록 → 파일명 검색 → 실제 코드 읽기
- 한눈에 보기: 루트 README(`.md`·`.txt`)의 첫 소개 문단을 ‘문서에 적힌 소개’로 표시(일반 텍스트, 코드와 맞는지는 미확인). `package.json`의 main·bin, index·main·app 파일, export된 함수에서 고른 ‘학습 시작점 후보’를 누르면 흐름 따라가기로 이동
- TS/JS 함수·화살표 함수·메서드 선택 → 조건문·반환문 등 구문 → 해당 원본 범위 강조
- 흐름 따라가기: 함수 하나를 코드에 적힌 순서대로 한 단계씩 보기. 받는 값, 반환·오류 던지기 위치, 확인하는 조건·돌려주는 값, if의 맞으면/아니면 단계로 이동, 이전/다음, 코드 읽기와 왕복
- 한글·이모지·BOM·CRLF를 유지한 코드 위치 확인
- 기존 파일·제외 규칙 변경 감지, 근거 사용 전 해시 재검사
- 프로젝트 전환·취소 시 분석 worker와 감시 정리
- SQLite에 연 프로젝트 식별 정보 저장
- 질문 탭에서 로컬 워커·Codex·Claude Code·Antigravity 선택, 설치 위치·버전 확인

프로젝트 목적과 실제 실행 흐름은 아직 자동으로 설명하지 않습니다. 구문 목록을 실행 순서나 AI 설명으로 표시하지 않습니다. **AI 호출은 도구 접근·설정 분리 조건이 미검증이므로 비활성화되어 있고, 외부로 소스를 전송하지 않습니다.**

## 로컬 워커 연결 구현

기본 사용 방식은 **Codex 작업 정리 → Antigravity의 Gemini 워커 설명 → Codex 코드 대조**입니다. Gemini 요청 모델은 `gemini-3.8-flash-high`로 고정하며 API 키·다른 모델로 자동 전환하지 않습니다. 단독 Codex·Claude Code·Antigravity 선택지는 후속 연결을 위한 것으로 아직 실행되지 않습니다.

프로젝트를 열고 오른쪽 **질문 → 로컬 AI 설치 확인**을 누르면 기본 설치 위치에서 공식 프로그램의 `--version`만 실행합니다. 설치 여부·버전을 확인해도 로그인 성공이나 실제 AI 연결 성공으로 표시하지 않습니다. 기본 위치 밖의 사용자 지정 실행 파일 선택은 아직 제공하지 않습니다.

질문 입력·전송 동의·진행 단계·AI 작업 취소·근거가 있는 응답 표시와 로컬 워커 실행 코드를 구현했습니다. **현재 실제 질문 전송은 main에서 차단합니다.** Antigravity의 전역 훅·플러그인과 기존 인증을 분리하는 방법을 검증하지 못했기 때문입니다. UI나 환경변수로 이 차단을 해제하는 옵션은 없습니다. 워커 흐름 테스트는 가짜 응답을 사용하며 실제 계정 연결 검증을 대신하지 않습니다.

AI로 보낼 코드와 질문(이전 질문 포함)은 프롬프트에 넣기 직전에 흔한 비밀값 형태(개인키 블록, AWS·GitHub·`sk-`·Google·Slack·Stripe 토큰, JWT, 접속 문자열 비밀번호, password·token·secret·api key 같은 이름에 넣은 값)를 `[MASKED_SECRET]`으로 가리고, 가린 파일·질문을 답변의 ‘읽기 범위’에 알립니다(`src/core/ai/secrets.ts`). 원본은 바꾸지 않으며 모든 비밀값을 찾는다고 보장하지 않습니다.

질문은 선택한 함수/구문에서 시작하고, **같은 프로젝트의 관련 파일도 읽을 수 있도록 구현했습니다.** Codex가 허용된 파일 목록에서 최대 4개의 ID를 고르면 앱이 제외 규칙을 다시 확인하여 읽습니다. 파일 경로나 셸 명령을 AI가 직접 실행하지 않습니다. 선택 범위와 파일 하나는 각각 최대 32 KiB, 전체 코드 자료는 128 KiB이며 생략한 파일은 이유를 표시합니다. 실제 모델을 통한 파일 선택은 아직 시험하지 않았습니다.

답변은 원래 근거와 읽은 파일들의 해시에 연결합니다. 각 AI 단계 전과 최종 표시 전에 변경 여부를 확인하고, 관련 파일 근거로 이동해도 질문 기준과 답변을 유지합니다. 새 코드 선택은 새 대화가 됩니다. 대화는 앱 실행 중에만 제한된 양을 보관하며 SQLite에 저장하지 않습니다. 로컬이라는 말은 실행기가 Mac에서 동작한다는 뜻이고, 활성화 후 모델의 답변 생성은 제공자 서버에서 이뤄집니다.

macOS의 원본 쓰기 차단은 비밀 없는 임시 파일에서 확인했습니다. `npm run test:ai-sandbox`는 읽기 허용, 수정·생성·삭제·이름 변경·하위 프로세스 쓰기 차단을 검사합니다. **이 검사는 실제 AI 실행기의 로그인·도구 제한 검증을 대신하지 않으며, 해당 제한을 아직 production 실행기에 활성화하지 않았습니다.**

## 실행

현재 만든 macOS arm64 앱:

`out/Code Learning-darwin-arm64/Code Learning.app`

개발 실행은 이 폴더에서 `npm start`입니다. 설치된 의존성 버전은 `package-lock.json`에 고정했습니다. 새 환경에서는 `npm ci` 후 아래 검증을 실행합니다.

```sh
npm run typecheck
npm test
npm run package
npm run test:electron
npm run test:packaged
npm run test:ai-sandbox
```

앱은 Codex를 개인 설정(`~/.codex`)과 분리된 앱 전용 위치(`~/Library/Application Support/Code Learning/codex-home`)로 실행합니다. 처음 한 번 `CODEX_HOME="$HOME/Library/Application Support/Code Learning/codex-home" codex login`으로 로그인해야 합니다. Antigravity(agy)는 설정 위치 옵션이 없어 앱 전용 폴더를 `HOME`으로 주어 실행하며(공식 기능 아님), 처음 한 번 터미널에서 `HOME="$HOME/Library/Application Support/Code Learning/agy-home" ~/.local/bin/agy`로 로그인합니다. `npm run test:agy-live`는 agy 연결 시험입니다.

`npm run test:codex-live`는 사용자 Codex 계정으로 비밀 없는 작은 시험 코드를 실제로 보내는 연결 시험(C01~C03 일부)이라 위 목록과 `npm test`에 포함하지 않습니다. 앱의 질문 전송 차단은 그대로 둔 채 실행 코드만 시험하며, 결과는 `test-results/codex-live.json`에 통과 여부·분류만 남깁니다.

계정 요청 없이 Codex의 제공 도구와 agents 설정 위치만 확인하려면 `npm run test:codex-live -- -t 'C05 local|C07 local'`을 실행합니다. macOS `sandbox-exec`와 로컬 포트 열기가 필요하며, 임시 HOME·CODEX_HOME과 가짜 응답 서버만 사용합니다. 외부 통신·개인 설정·키체인 경로 접근을 차단하고, 도구 호출 응답은 만들지 않습니다. C05는 가짜 개인 홈의 agents 자료만 읽습니다. C07은 일반 `tools`와 Responses Lite의 `input.additional_tools`, Code Mode의 `exec` 설명에 있는 도구 선언을 수집합니다. 지연 제공되는 도구까지 모두 보인다는 보장은 없으며, 이 결과를 실제 로그인 조건의 C04 통과로 취급하지 않습니다.

로컬 결과는 `test-results/codex-local-probe.json`과 실행별 `codex-local-probe-<ID>.json`에 도구 이름·종류·수치만 기록합니다. 프롬프트·응답·헤더 원문을 저장하지 않으며, 로컬 시험만 실행하면 기존 `codex-live.json`은 보존합니다.

C07은 현재 앱 설정, `code_mode`·`code_mode_only` 끄기, 공식 `model_catalog_json`으로 직접 도구 모드·파일 편집 도구 없음 설정을 지정하는 세 조건을 비교합니다. 뒤의 두 조건은 시험에만 적용합니다. 카탈로그 시험은 공식 0.163.0의 `gpt-6.1-sol` 자료와 같은 CLI 버전만 허용하며, 원본에서 `tool_mode`·`apply_patch_tool_type` 두 필드만 바꿉니다. 시험 자료의 출처·해시는 `tests/fixtures/codex-model-0.163.0.json`, 라이선스·고지는 같은 폴더의 `codex-model-LICENSE.txt`·`codex-model-NOTICE.txt`에 있습니다. 앱은 이미지·협업 끄기와 Code Mode의 `functions` 간접 도구 제외를 적용했지만 `exec` 자체는 남아 있어 질문 보내기 잠금을 유지합니다.

화면 자동검사는 서로의 창 포커스에 영향을 줄 수 있으므로 순서대로 실행합니다. 테스트는 자체 임시 프로젝트와 별도 앱 데이터 경로를 사용하며 외부 AI를 호출하지 않습니다. 작은 탐색 예제는 `fixtures/small-ts`입니다.

## 개발 역할과 화면 연결 기준

**Claude가 기획·디자인·기능·로직 구현·시험·문서를 모두 맡고, Codex는 읽기 전용 검토만 합니다.** 구현 기획을 확정하기 전과 커밋 전에 Codex 검토를 받습니다(2026-10-15 변경, 기획서 23.1절). 현재 `src/renderer`에는 작업 공간 UI가 1차 적용되어 있습니다. 네 가지 보기, 파일 목록·검색, 설명·질문 패널과 패널 접기를 제공합니다. 한눈에 보기는 확인 범위를 표시하고, 흐름 따라가기는 함수 하나를 코드에 적힌 순서대로 보여 줍니다. 변경 이력·AI 설명은 아직 준비 중입니다. 디자인 시스템이나 테마 프레임워크는 추가하지 않았습니다.

- 화면이 쓰는 API: `src/shared/contracts.ts`의 `LearningApi`와 `window.learning`.
- 화면 상태: `src/renderer/selection.ts`에서 현재 보기(`overview | flow | code | changes`)와 함수·단계 선택을 공유합니다. 프로젝트가 바뀌면 한눈에 보기로, 파일을 선택하면 코드 읽기로 이동합니다. 흐름 따라가기에서 파일을 고르면 그 보기에 머뭅니다.
- `openProject()`는 OS 폴더 선택창을 엽니다. 화면에서 임의 경로를 전달하지 않습니다.
- `readSource()`와 `readEvidence()`는 main이 발급한 프로젝트·파일·근거 ID만 받습니다.
- `cancel()`은 현재 프로젝트를 닫고 작업을 정리합니다. 비동기 응답은 요청 번호를 대조한 뒤 반영합니다.
- `onProjectEvent()` 수신 시 이전 근거 강조를 해제합니다. UI가 파일·DB·셸에 직접 접근해서는 안 됩니다.

변경·실패·취소·AI 미연결 상태를 디자인에도 유지해야 합니다. 디자인 교체를 위해 프로세스 권한이나 분석 로직을 renderer로 옮기지 않습니다.

취소 성공은 `role="status"`·`.notice--info`, 오류는 `role="alert"`로 구분합니다. 취소 문구 ‘작업을 취소했습니다.’는 자동검사에서도 사용합니다. 프로젝트 목적(AI 설명)·역할 카드·프로젝트 전체 실행 흐름 타입은 아직 없습니다. `ProjectView.overview`는 폴더를 열 때 worker가 계산한 소개·시작점 후보입니다. 후보는 근거 ID가 아니며, 화면은 파일을 다시 읽어 해시가 같을 때만 그 함수를 고릅니다. 열린 뒤 변경 이벤트가 오면 개요에 ‘다시 확인 필요’를 표시하고, 폴더를 다시 열 때만 지웁니다. `CodeStep`은 구문 위치이며 실제 실행 흐름을 뜻하지 않습니다. `CodeStep.detail`은 조건·반환 값 같은 원문 일부(최대 300자)이고, `branch`는 if의 조건이 맞을 때와 아닐 때 같은 함수 안에서 이어지는 단계 ID입니다. 문장 목록 밖이라 확인할 수 없으면 null이며, 화면은 ‘다음 연결을 확인하지 못했어요’로 표시합니다. `CodeSymbol.params`는 매개변수 원문입니다.

AI 설명 계약은 `src/shared/ai.ts`의 `Explanation`입니다: `summary`, `steps`(제목·입력·처리·결과·다른 경우·근거 ID), `claims`(코드 근거 또는 일반 개념), `terms`, `unknowns`. `LearningResult`는 원래 질문·근거·`sources`(제공한 파일별 근거와 경로)·`limitations`(읽기 제한)·호출/응답 모델·‘AI 검토됨’ 상태를 함께 전달합니다. main에서 형식·참조·최신성을 검사합니다. AI 검토는 정확성 보장이 아닙니다.

- `checkConnections()`는 설치·버전과 미검증 이유를 반환합니다.
- `startExplanation()`은 허용된 프로젝트·근거 ID, 기대 해시, 질문, 명시적 전송 동의만 받습니다. 현재는 실행 준비 차단 오류를 반환합니다.
- `onLearningEvent()`는 작업 ID에 연결된 진행·완료·실패 이벤트를 받습니다.
- `cancelExplanation({jobId})`는 해당 AI 작업만 취소합니다. 기존 `cancel()`은 프로젝트까지 닫습니다.
- `src/renderer/ai-panel.tsx`에는 질문 패널의 기능 연결을 추가했습니다.
- 진행 단계 `reading-related`는 관련 파일 읽기입니다. 질문 기준 경로·행, 관련 파일 전송 동의, 답변의 파일별 근거 버튼을 유지해야 합니다. 답변 근거를 보러 이동하는 것과 새 질문 대상을 선택하는 것은 구분합니다.

## 구현 위치

| 위치 | 역할 |
|---|---|
| `src/main` | 창, IPC 요청 검사, 프로젝트 세션·작업 취소·파일 감시 |
| `src/preload` | 화면에 필요한 제한된 API만 전달 |
| `src/workers/analysis.ts` | 작업자 하나에서 탐색·분석·근거 대조 |
| `src/core/project/files.ts` | 제외 규칙, 읽기 경계, 크기·UTF-8·해시 검사 |
| `src/core/analysis/syntax.ts` | Tree-sitter 구문 추출과 UTF-16 근거 |
| `src/core/analysis/overview.ts` | 한눈에 보기의 README 소개와 학습 시작점 후보(파일은 텍스트로만 읽음) |
| `src/core/storage/projects.ts` | Electron 내장 SQLite로 프로젝트 정보 저장 |
| `src/core/ai` | 로컬 설치 확인·실행 차단, 제한된 자식 프로세스, 앱 중개 파일 읽기·3단계 워커·다중 근거 검사·대화 수명 |

검증 결과, 알려진 한계와 다음 작업은 [구현 상태](docs/implementation-status.md)에 기록했습니다.
