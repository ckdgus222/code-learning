# Code Learning

**처음 보는 TypeScript·JavaScript 프로젝트를 코드 근거와 함께 쉽게 이해하게 돕는 읽기 전용 데스크톱 앱이에요.**

Explore unfamiliar TypeScript and JavaScript projects with evidence from the code.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS (Apple silicon) | Windows (x64)](https://img.shields.io/badge/Platform-macOS%20%28Apple%20silicon%29%20%7C%20Windows%20%28x64%29-555)](#-설치)
[![최신 릴리스](https://img.shields.io/github/v/release/ckdgus222/code-learning)](https://github.com/ckdgus222/code-learning/releases/latest)

**[macOS (Apple silicon) 내려받기](https://github.com/ckdgus222/code-learning/releases/latest/download/Code-Learning-mac-arm64.dmg) · [Windows (x64) 내려받기](https://github.com/ckdgus222/code-learning/releases/latest/download/Code-Learning-win-x64-Setup.exe)** · [모든 버전](https://github.com/ckdgus222/code-learning/releases)

처음 열 때 경고가 나오는 이유와 여는 방법은 [설치](#-설치)를 봐 주세요.

[설치](#-설치) · [사용법](#-사용법) · [AI 기능](#-ai-기능-선택) · [안전](#-안전과-개인정보)

![기능 흐름의 첫 단계에서 화면 코드와 근거 줄을 함께 보는 모습](docs/images/feature-flow.png)

*스크린샷은 공개 프로젝트 [shadcn-ui/taxonomy](https://github.com/shadcn-ui/taxonomy)(MIT)를 연 화면이에요.*

## 🎯 이런 분께

- AI가 짜 준 코드를 검토하고 싶을 때
- 새 팀이나 오픈소스 프로젝트의 구조를 알고 싶을 때
- “이 버튼을 누르면 서버에서 무슨 일이 일어날까?”가 궁금할 때

## ✨ 할 수 있는 일

### 🗺️ 한눈에 보기

프로젝트 README의 소개와 코드에서 찾은 화면·요청·서버 기능 수를 보고, 추천 기능의 코드로 이동해요. README 소개가 실제 코드와 맞는지는 확인하지 않아요.

![README 소개, 프로젝트 구성, 처음 따라갈 기능을 보여 주는 한눈에 보기](docs/images/overview.png)

*taxonomy의 소개와 구성을 한곳에서 봐요.*

### 🔀 기능 흐름 따라가기

**화면 → 프론트 처리 → 요청 → 서버 받는 곳 → 서버 처리 → 저장소(DB)**

프론트(화면 쪽 코드)부터 DB(데이터를 보관하는 곳)까지 실제 코드와 근거 줄을 따라가요. 불확실한 연결은 **추정**으로 표시하고, 찾지 못한 단계는 생략해요.

![화면에서 시작하는 기능 흐름과 해당 코드](docs/images/feature-flow.png)

*taxonomy의 글 수정 기능: 1단계에서 화면 코드를 봐요.*

![서버 처리 단계에서 DB 호출 코드가 강조된 모습](docs/images/feature-flow-server.png)

*같은 기능의 5단계: 권한 확인 함수와 DB 호출 코드예요.*

### 🧭 프로젝트 지도

폴더·파일 사이의 **import(다른 파일의 코드를 가져다 쓰는 연결)**를 그림으로 보며, 화살표는 실행 순서를 뜻하지 않아요. 파일이 **80개**를 넘으면 폴더별로, 바로 아래 파일이 **30개**를 넘는 폴더는 목록과 고른 파일 주변 지도로 봐요.

![폴더 상자와 import 연결 화살표로 표시한 프로젝트 지도](docs/images/file-map.png)

*taxonomy의 폴더 사이 연결이에요. 파일을 고르면 코드가 열려요.*

### 📖 코드 읽기

파일 목록과 파일명 검색으로 코드를 찾고, 함수 안의 단계와 해당 줄을 함께 봐요. 함수를 고르고 **이 함수 흐름으로 보기**(함수 안 순서)를 열면 그 함수가 부르는 것·부르는 곳, 값의 선언·전달 경로, TypeScript 타입(값의 모양)을 볼 수 있어요. 실행 중의 값이 아니라 코드에 적힌 정보예요.

![파일 트리, 함수 목록, 선택한 함수의 코드 강조](docs/images/code-reading.png)

*taxonomy의 서버 파일에서 함수를 골라 읽어요.*

### 🔍 코드 검토와 AI 설명

- **검토 도우미:** 안 쓰는 파일·export(다른 파일에 공개한 함수나 값) 후보와 길거나 깊게 중첩된 함수를 표시해요. **삭제해도 된다는 판정은 아니에요.**
- **달라진 내용:** Git의 기준 커밋(저장된 변경 시점)과 지금 코드를 나란히 봐요. 사람과 AI의 변경은 구분하지 않으며, **Windows에서는 v1.0의 달라진 내용(git)을 쓸 수 없어요.**
- **AI 설명 · 선택:** 고른 AI 하나에 함수·파일 설명, 기능 정리, 코드 질문, AI 개요를 요청해요. 근거 버튼으로 코드를 열 수 있고, 앱은 근거와 파일 변경 여부를 다시 확인해요.
- **기획 대조 · 선택:** 기획 문서와 코드를 비교해 ‘기획대로 있음·다름·확인 못 함·못 찾음·시키지 않은 작업 후보’를 보여 줘요. **‘못 찾음’은 구현이 없다는 확정이 아니에요.**

## 📥 설치

### macOS (Apple silicon)

1. [macOS 설치 파일(.dmg)](https://github.com/ckdgus222/code-learning/releases/latest/download/Code-Learning-mac-arm64.dmg)을 내려받아요.
2. `.dmg`를 열고 **Code Learning**을 **Applications**로 끌어 놓아요.
3. 처음 열 때 경고가 나오면 아래 순서로 한 번 허용해 주세요.

M1 이후 Apple silicon Mac용이에요. **Intel Mac은 지원하지 않아요.**

<details open>
<summary>처음 열 때 경고가 나와요</summary>

개인이 만든 오픈소스 앱으로, Apple 유료 개발자 프로그램의 서명·공증(배포자 확인과 앱 검사)을 받지 않았어요. 그래서 처음 열 때 이런 경고가 나와요.

> Apple은 ‘Code Learning’에 사용자의 Mac에 손상을 입히거나 사용자의 개인정보에 침입할 수 있는 악성 코드가 없음을 확인할 수 없습니다.

Apple이 앱을 검사하지 않았다는 뜻이지, 악성 코드를 찾았다는 뜻은 아니에요.

1. Applications에서 앱을 열고 경고를 **완료**로 닫아요. **휴지통으로 이동은 누르지 마세요. 앱이 지워져요.**
2. **시스템 설정 → 개인정보 보호 및 보안** 아래쪽에서 Code Learning 옆 **그래도 열기**를 눌러요.
3. Mac 로그인 암호를 입력하고 **열기**를 눌러요. 다음부터는 바로 열려요.

차단 안내와 **그래도 열기**는 앱을 열려고 한 뒤 약 1시간 동안 보여요. 안 보이면 앱을 다시 열어 경고를 띄워 주세요.
macOS 버전에 따라 버튼 문구가 다를 수 있어요. [Apple의 실행 허용 안내](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)도 참고해 주세요.

</details>

<details>
<summary>터미널로 첫 실행 차단 풀기</summary>

공식 배포 파일을 Applications로 옮긴 뒤 실행해요. 앱과 그 안의 파일에서 다운로드 격리 표시를 지워요.

```sh
xattr -dr com.apple.quarantine "/Applications/Code Learning.app"
```

</details>

### Windows (x64)

1. [Windows 설치 파일(Setup.exe)](https://github.com/ckdgus222/code-learning/releases/latest/download/Code-Learning-win-x64-Setup.exe)을 내려받아 실행해요.
2. **Windows의 PC 보호**가 나오면 **추가 정보 → 실행**을 눌러요. 코드 서명 인증서로 서명하지 않아 Windows가 만든 사람을 확인하지 못하기 때문이에요.
3. 관리자 권한 없이 내 계정에 설치돼요. 시작 메뉴와 바탕화면에 **Code Learning** 바로가기가 생겨요.

제거하려면 **설정 → 앱 → Code Learning → 제거**를 눌러요.

<details>
<summary>설치 파일 직접 확인하기</summary>

소스 코드 전체가 이 저장소에 있어요. GitHub Actions의 [릴리스 작업](.github/workflows/release.yml)이 이 코드로 설치 파일을 만들어요. 릴리스의 `SHA256SUMS.txt`(파일이 같은지 확인하는 값 목록)로 내려받은 파일이 바뀌지 않았는지 확인해요.

설치 파일과 `SHA256SUMS.txt`를 같은 폴더에 놓고, 그 폴더에서 실행해요. macOS 터미널에서 `OK`가 나오면 파일이 같아요.

```sh
grep Code-Learning-mac-arm64.dmg SHA256SUMS.txt | shasum -a 256 -c
```

Windows PowerShell에서 `True`가 나오면 파일이 같아요.

```powershell
(Get-FileHash .\Code-Learning-win-x64-Setup.exe -Algorithm SHA256).Hash -eq (Select-String -Path SHA256SUMS.txt -Pattern 'Code-Learning-win-x64-Setup.exe' -SimpleMatch).Line.Split(' ')[0]
```

직접 만들려면 [개발](#-개발)을 봐 주세요.

</details>

## 🚀 사용법

1. **프로젝트 폴더 열기**로 살펴볼 폴더를 골라요.
2. **한눈에 보기**에서 소개와 구성을 봐요.
3. **이 기능부터 따라가기**로 단계별 코드를 읽어요. 서버 기능을 못 찾으면 **어디부터 읽을까요?**에서 시작 파일을 골라요.
4. **프로젝트 지도**에서 폴더·파일 연결을 봐요.

- 코드 분석은 **TypeScript·JavaScript**를 지원해요.
- 기능 흐름은 **NestJS·Next API·Express** 서버와 **fetch·axios** 요청을 찾아요.
- 최대 **1,000개 파일**, 파일당 **256 KiB**, **UTF-8** 텍스트를 읽어요.
- 제외한 파일은 이유를 표시해요. 탐색 한도에 닿으면 더 작은 폴더를 열어 주세요.

## 🤖 AI 기능 (선택)

**탐색·흐름·지도·변경 비교(macOS)는 AI 없이도 돼요.** 고른 AI 하나가 설명하며, 보낼 자료의 종류와 범위를 안내하고 동의를 받은 뒤에만 보내요. AI 실행기는 내 컴퓨터에서 돌지만, 답은 각 AI 회사 서버가 만들어요.

| 방식 | macOS | Windows |
|---|---|---|
| Codex 단독 (기본) | 가능 | 실험 (미검증) |
| Gemini 단독 (Antigravity) | 가능 | 불가 |
| Claude Code 단독 | 준비 중 | 준비 중 |

**Windows AI는 접근 제한 장치(울타리) 없이 실행해요. 도구 차단이 새면 PC의 파일을 읽거나 바꿀 수 있어요.**

<details>
<summary>macOS에서 AI 켜기</summary>

**1. 필요한 CLI(터미널에서 실행하는 프로그램)를 설치해요.**

- **Codex:** [공식 설치 안내](https://developers.openai.com/codex/cli/)를 따라 설치하고 ChatGPT 계정으로 로그인해요.
- **Antigravity:** [공식 설치 안내](https://antigravity.google/docs/getting-started)의 CLI 항목에서 `agy`를 설치해요. Gemini 모델은 **3.8 Flash · High**(`gemini-3.8-flash-high`)로 고정돼요.

앱은 `~/.local/bin`, `~/.npm-global/bin`, `/opt/homebrew/bin`, `/usr/local/bin`에서만 실행 파일을 찾아요. 다른 위치는 찾지 못할 수 있어요.

**2. 앱 전용 폴더를 만들고 처음 한 번 로그인해요.** 개인 AI 설정과 분리돼 기존 터미널 로그인만으로는 연결되지 않을 수 있어요. macOS 터미널에서 쓸 AI의 명령을 실행해요.

Codex:

```sh
mkdir -p "$HOME/Library/Application Support/Code Learning/codex-home"
CODEX_HOME="$HOME/Library/Application Support/Code Learning/codex-home" codex login
```

Antigravity:

```sh
mkdir -p "$HOME/Library/Application Support/Code Learning/agy-home"
HOME="$HOME/Library/Application Support/Code Learning/agy-home" agy
```

Antigravity는 로그인을 마치고 종료해요. 앱 전용 HOME 방식은 Antigravity의 공식 설정 기능이 아니어서 CLI 업데이트의 영향을 받을 수 있어요.

**3. 앱에서 질문해요.** 위 **질문** 버튼을 누르면 설치 확인이 시작되고, 질문 칸의 **설정**에서 방식을 골라요. **코드 읽기**에서 함수나 구문을 고르고 질문을 적은 뒤, **무엇을 보내나요?**를 확인하고 전송에 동의해요.

설치 확인은 실행 파일과 버전만 확인해요. 로그인이나 이용 한도에 문제가 있으면 AI 요청이 실패해요.

</details>

<details>
<summary>Windows에서 AI 켜기 (실험)</summary>

**Codex 단독만 가능하며, 실제 Windows PC에서 확인하지 못했어요.** macOS의 울타리 없이 실행해 도구 차단이 새면 PC의 파일을 읽거나 바꿀 수 있어요.

**1. Node.js와 Codex를 설치해요.** Node.js는 공식 설치 프로그램으로 `C:\Program Files\nodejs`에 설치해요. Codex는 `npm install -g @openai/codex`로 기본 전역 위치인 `%APPDATA%\npm`에 설치해요.

앱은 이 위치들에서만 찾아요.

**2. PowerShell에서 앱 전용 폴더를 만들고 처음 한 번 로그인해요.**

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\Code Learning\codex-home" | Out-Null
$env:CODEX_HOME="$env:APPDATA\Code Learning\codex-home"; codex login
```

**3. 질문 칸 → 설정에서 Codex 단독을 골라요.** 보낼 자료를 확인하고 동의하면 질문·파일 설명·기능 정리·AI 개요·기획 대조를 요청할 수 있어요.

설치 확인은 실행 파일과 버전만 확인해요. 로그인이나 이용 한도에 문제가 있으면 요청이 실패해요.

**Gemini 단독은 Windows에서 쓸 수 없어요.**

</details>

## 🔒 안전과 개인정보

- **읽기 전용:** 앱은 프로젝트 파일을 바꾸거나 프로젝트의 코드·설정·스크립트를 실행하지 않아요.
- **AI를 쓰지 않을 때:** 코드를 외부로 보내지 않아요. 사용 기록을 외부로 수집하는 기능(텔레메트리)도 없어요.
- **새 버전 확인:** **앱 설정**(톱니)의 **새 버전 확인**을 누를 때만 GitHub(`api.github.com`)에 한 번 물어봐요. 자동으로 확인하지 않고, 프로젝트 정보도 보내지 않아요. 새 버전이 있으면 릴리스 페이지를 열어 줄 뿐 자동 설치는 하지 않아요.
- **AI 전송:** **무엇을 보내나요?**에서 보낼 자료의 종류와 범위를 안내하고, 동의한 뒤에만 해당 AI 회사로 보내요. 흔한 비밀값 형태를 `[MASKED_SECRET]` 등으로 가리지만, 전부 가린다고 보장하지 않아요.
- **AI 실행 제한:** Codex와 Gemini 실행기는 앱 전용 폴더와 임시 폴더를 써요. macOS에서는 접근 제한 장치(울타리, `sandbox-exec`) 안에서만 실행하고, 울타리를 쓸 수 없으면 실행하지 않아요. 단, 설치 확인 때 Claude Code의 버전 확인(`--version`)은 울타리 없이 실행해요.
- **AI 실행 제한의 한계:** 도구 차단은 **시험한 범위만 확인**했고, 네트워크 전송은 막지 않아요. Windows Codex는 울타리 없이 실행해서 차단이 새면 PC 파일을 읽거나 바꿀 수 있어요. [한계 전체](docs/development.md#알려진-한계)를 봐 주세요.
- **내 컴퓨터에 저장:** 최근 프로젝트·학습 위치와 메모·AI 결과는 macOS의 `~/Library/Application Support/Code Learning/learning.sqlite`, Windows의 `%APPDATA%\Code Learning\learning.sqlite`에 저장해요. 앱 설정(화면·코드 색)은 같은 폴더의 `view-settings.json`에 저장해요. AI CLI도 앱 전용 폴더에 자체 기록을 남길 수 있으며, 보관·삭제 정책은 아직 확인하지 못했어요.

## ⚠️ 알려진 한계

- 코드 분석은 TypeScript·JavaScript만 지원해요. 문서 등 일부 텍스트 파일은 읽을 수 있어요.
- 주소 문자열과 코드 모양으로 연결을 찾아요. 실제 실행을 확인한 결과는 아니에요.
- 경로 별칭(예: `@/…`)은 일부만 지원해요. Fastify·Hono·Koa 등은 기능 흐름 분석 대상이 아니에요.
- AI 답과 기획 대조는 정확성을 보장하지 않으며, 다른 AI의 대조도 없어요. 근거 코드가 바뀌면 다시 확인해야 하고, 오래된 근거로 이동하는 기능은 막혀요.
- Windows AI는 **Codex 단독만 가능한 실험 기능**이며 실제 Windows PC에서 확인하지 못했어요. 울타리가 없어 도구 차단이 새면 PC 파일을 읽거나 바꿀 수 있어요.
- AI 요청을 취소하거나 시간이 지나도, AI 프로그램이 띄운 다른 프로그램(하위 프로세스)이 남을 수 있어요. 예를 들어 Windows에서 종료 명령(`taskkill`)이 실패하거나 2초 안에 끝나지 않을 때, 또는 CLI가 하위 프로세스를 떼어 놓고 먼저 끝날 때예요.
- CLI 업데이트로 AI 동작과 도구 제한이 달라질 수 있어요. [개발 문서의 알려진 한계](docs/development.md#알려진-한계)를 봐 주세요.

## 🛠️ 개발

macOS Apple silicon·**Node.js 24** 기준이에요. 저장소 폴더에서 실행해요.

```sh
npm ci
npm start
```

검증은 아래 순서예요. 화면 검사는 서로 영향을 주지 않도록 하나씩 실행해요.

```sh
npm run typecheck
npm test
npm run package
npm run test:electron
npm run test:packaged
```

macOS 설치 파일은 `npm run make`로 만들며, 결과는 `out/make/Code-Learning-mac-arm64.dmg`에 생겨요. Windows에서는 `npm run make:win`으로 만들며, 결과는 `out/make/squirrel.windows/x64/Code-Learning-win-x64-Setup.exe`에 생겨요.
구조와 추가 검증은 [개발 문서](docs/development.md), 시험 기록은 [구현 상태](docs/implementation-status.md)를 봐 주세요.

## 📄 라이선스

[MIT](LICENSE)
