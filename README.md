# Code Learning

처음 보는 TypeScript·JavaScript 프로젝트를 코드 근거와 함께 읽어 나가는 데스크톱 앱입니다. 프로젝트 파일은 읽기만 합니다.

Explore unfamiliar TypeScript and JavaScript projects with evidence from the code.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS (Apple silicon) | Windows (x64)](https://img.shields.io/badge/Platform-macOS%20%28Apple%20silicon%29%20%7C%20Windows%20%28x64%29-555)](#설치)
[![최신 릴리스](https://img.shields.io/github/v/release/ckdgus222/code-learning)](https://github.com/ckdgus222/code-learning/releases/latest)

**[macOS (Apple silicon) 내려받기](https://github.com/ckdgus222/code-learning/releases/latest/download/Code-Learning-mac-arm64.dmg)** · **[Windows (x64) 내려받기](https://github.com/ckdgus222/code-learning/releases/latest/download/Code-Learning-win-x64-Setup.exe)** · [모든 버전](https://github.com/ckdgus222/code-learning/releases) · [소개 페이지](https://ckdgus222.github.io/code-learning/)

[설치](#설치) · [사용법](#사용법) · [AI 기능](#ai-기능-선택) · [안전과 개인정보](#안전과-개인정보)

![기능 흐름의 첫 단계에서 화면 코드와 근거 줄을 함께 보는 모습](docs/images/feature-flow.png)

스크린샷은 공개 프로젝트 [shadcn-ui/taxonomy](https://github.com/shadcn-ui/taxonomy)(MIT)를 연 화면입니다.

## 이런 때 씁니다

- AI가 짜 준 코드를 검토할 때
- 새 팀이나 오픈소스 프로젝트의 구조를 파악할 때
- 버튼을 누르면 서버에서 무슨 일이 일어나는지 궁금할 때

## 기능

### 한눈에 보기

README 소개와 코드에서 찾은 화면·요청·서버 기능 수를 보여 주고, 처음 따라갈 기능을 추천합니다. README 소개가 실제 코드와 맞는지는 확인하지 않습니다.

지도의 import 연결로 AI 없이 읽는 순서를 추천합니다. 시작 파일 후보 최대 3개부터, import로 가까운 파일 순으로 읽을 수 있습니다.

![README 소개, 프로젝트 구성, 처음 따라갈 기능을 보여 주는 한눈에 보기](docs/images/overview.png)

### 기능 흐름 따라가기

화면 → 프론트 처리 → 요청 → 서버 받는 곳 → 서버 처리 → 저장소(DB) 순서로, 기능 하나를 실제 코드와 줄 번호로 따라갑니다. 확실하지 않은 연결은 '추정'으로 표시하고, 찾지 못한 단계는 건너뜁니다.

![서버 처리 단계에서 권한 확인 함수와 DB 호출 코드를 보는 모습](docs/images/feature-flow-server.png)

taxonomy의 글 수정 기능 5단계입니다. 권한을 확인하는 함수와 DB 호출 코드가 보입니다.

### 프로젝트 지도

지도의 요약과 폴더 그림을 Markdown으로 저장하거나 복사할 수 있습니다.

폴더와 파일 사이의 import 관계를 그림으로 봅니다. 화살표는 실행 순서가 아닙니다. 파일이 80개를 넘으면 폴더 단위로 묶고, 바로 아래 파일이 30개를 넘는 폴더는 목록과 고른 파일 주변 지도로 보여 줍니다.

파일 지도에서 출발·도착 파일을 고르면 import를 따라가는 가장 짧은 길을 보여 줍니다. 확정된 길이 없을 때만 추정 연결까지 따라가며, 추정이 섞인 길과 해당 걸음을 표시합니다.

![폴더 상자와 import 화살표로 그린 프로젝트 지도](docs/images/file-map.png)

### 코드 읽기

왼쪽 검색 칸에서 파일과 함수·클래스 이름을 함께 찾습니다. 이름 검색은 지도가 읽은 TS/JS·Python 파일에서 찾고, 결과를 누르면 해당 코드로 이동합니다.

파일 트리와 검색으로 파일을 열고, 함수 안의 구문 단계와 해당 줄을 함께 봅니다. 함수를 고르고 '이 함수 흐름으로 보기'를 열면 그 함수가 부르는 것과 부르는 곳, 값이 어디서 오는지, TypeScript 타입을 볼 수 있습니다. 모두 코드에 적힌 정보이고, 실행 중의 값은 아닙니다.

![파일 트리, 함수 목록, 고른 함수의 코드를 함께 보는 모습](docs/images/code-reading.png)

### 그 밖에

- 아무도 가져다 쓰지 않는 파일·export 후보와 긴 함수, 깊은 중첩을 표시합니다. 지워도 된다는 뜻은 아닙니다.
- '달라진 내용'에서 Git 커밋과 지금 코드를 나란히 비교합니다. macOS에서만 되고, 사람이 바꿨는지 AI가 바꿨는지는 구분하지 않습니다.
- 커밋과 비교하면 바뀐 파일을 직접 가져다 쓰는 파일도 목록과 지도 상자에 표시합니다. 추정 연결도 ‘추정’ 표시와 함께 포함합니다.
- 삭제됐거나 이름이 바뀐 파일을 옛 경로로 가져다 쓰는 import도 찾습니다. TS/JS의 상대 경로와 `paths` 별칭을 확인합니다.
- AI(선택)에게 함수·파일 설명, 기능 정리, 질문, 프로젝트 개요를 요청할 수 있습니다. 답에는 코드 근거 버튼이 붙고, 앱이 근거와 파일 변경 여부를 다시 확인합니다.
- 기획 대조(선택)는 기획 문서와 코드를 비교해 기획대로 있음·다름·확인 못 함·못 찾음·시키지 않은 작업 후보로 나눕니다. '못 찾음'이 구현이 없다는 뜻은 아닙니다.

## 설치

### macOS (Apple silicon)

1. [Code-Learning-mac-arm64.dmg](https://github.com/ckdgus222/code-learning/releases/latest/download/Code-Learning-mac-arm64.dmg)를 받습니다.
2. dmg를 열고 Code Learning을 Applications 폴더로 옮깁니다.
3. 처음 열 때 나오는 경고는 아래 방법으로 한 번만 허용하면 됩니다.

Intel Mac은 지원하지 않습니다.

#### 처음 열 때 경고가 나오면

Apple 유료 개발자 프로그램의 서명·공증을 받지 않은 앱이라, 처음 실행할 때 다음 경고가 나옵니다.

> Apple은 ‘Code Learning’에 사용자의 Mac에 손상을 입히거나 사용자의 개인정보에 침입할 수 있는 악성 코드가 없음을 확인할 수 없습니다.

Apple이 이 앱을 검사하지 않았다는 뜻이고, 악성 코드가 발견됐다는 뜻은 아닙니다.

1. 경고 창에서 **완료**를 누릅니다. **휴지통으로 이동**을 누르면 앱이 지워지니 주의하세요.
2. 시스템 설정 → 개인정보 보호 및 보안을 열고, 아래쪽 Code Learning 항목에서 **그래도 열기**를 누릅니다.
3. Mac 암호를 입력하고 **열기**를 누릅니다. 다음부터는 바로 열립니다.

'그래도 열기'는 앱을 열려고 한 뒤 1시간쯤만 보입니다. 보이지 않으면 앱을 한 번 더 열어 보세요. macOS 버전에 따라 문구가 다를 수 있습니다. [Apple 안내](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)도 참고하세요.

터미널이 편하다면 앱을 Applications로 옮긴 뒤 다음 명령으로 차단을 풀 수도 있습니다.

```sh
xattr -dr com.apple.quarantine "/Applications/Code Learning.app"
```

### Windows (x64)

1. [Code-Learning-win-x64-Setup.exe](https://github.com/ckdgus222/code-learning/releases/latest/download/Code-Learning-win-x64-Setup.exe)를 받아 실행합니다.
2. "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**을 누릅니다. 코드 서명을 하지 않은 설치 파일이라 나오는 화면입니다.
3. 관리자 권한 없이 내 계정에 설치되고, 시작 메뉴와 바탕화면에 바로가기가 생깁니다.

지우려면 설정 → 앱에서 Code Learning을 제거합니다.

<details>
<summary>내려받은 파일 확인하기</summary>

설치 파일은 이 저장소의 코드로 GitHub Actions의 [릴리스 작업](.github/workflows/release.yml)이 만듭니다. 릴리스에 함께 올린 `SHA256SUMS.txt`로 파일이 바뀌지 않았는지 확인할 수 있습니다. 설치 파일과 `SHA256SUMS.txt`를 같은 폴더에 두고 그 폴더에서 실행하세요.

macOS 터미널에서 `OK`가 나오면 정상입니다.

```sh
grep Code-Learning-mac-arm64.dmg SHA256SUMS.txt | shasum -a 256 -c
```

Windows PowerShell에서 `True`가 나오면 정상입니다.

```powershell
(Get-FileHash .\Code-Learning-win-x64-Setup.exe -Algorithm SHA256).Hash -eq (Select-String -Path SHA256SUMS.txt -Pattern 'Code-Learning-win-x64-Setup.exe' -SimpleMatch).Line.Split(' ')[0]
```

직접 빌드하려면 [개발](#개발)을 보세요.

</details>

## 사용법

1. **프로젝트 폴더 열기**로 폴더를 고릅니다.
2. **한눈에 보기**에서 프로젝트 소개와 구성을 봅니다.
3. 추천 기능의 **이 기능부터 따라가기**를 눌러 코드를 단계별로 읽습니다. 서버 기능을 찾지 못한 프로젝트라면 **어디부터 읽을까요?**에서 시작 파일을 고릅니다.
4. **프로젝트 지도**에서 폴더와 파일의 연결을 봅니다.

지원 범위는 다음과 같습니다.

- 언어: TypeScript, JavaScript
- Python: 코드 읽기(함수·클래스·import 목록·구문 단계·문법 색)와 프로젝트 지도의 import 연결(확정하지 못한 import는 후보 파일로 가는 추정 선). FastAPI·Flask·Django 주소와 프론트 요청의 기능 흐름은 Python 처리 함수까지 보여 줍니다. 파일 안내, 호출·값 찾기는 아직 지원하지 않습니다.
- 원문으로만 열기: Java, Go, Rust, Kotlin, C#, Ruby, PHP, Swift, C/C++, Vue, Svelte 등
- 기능 흐름: NestJS·Next API·Express 서버와 Python FastAPI·Flask·Django 주소, fetch·axios 요청
- 폴더 한도: 파일 1,000개, 파일당 256 KiB, UTF-8 텍스트. 제외한 파일은 이유를 보여 주며, 한도를 넘으면 더 작은 폴더를 열면 됩니다.
- 지도 한도: 지도 한 장에 담는 import·export가 아주 많으면 일부 결과나 파일을 생략하고 그 사실을 알려 줍니다.

## AI 기능 (선택)

탐색, 기능 흐름, 지도, 변경 비교는 AI 없이 동작합니다. AI는 고른 하나만 쓰며, 보낼 자료의 종류와 범위를 안내하고 동의를 받은 뒤에만 보냅니다. AI 프로그램(CLI)은 내 컴퓨터에서 실행되지만, 답은 각 AI 회사의 서버에서 만들어집니다.

| 방식 | macOS | Windows |
|---|---|---|
| Codex (기본) | 지원 | 실험 기능, 미검증 |
| Gemini (Antigravity) | 지원 | 미지원 |
| Claude Code | 준비 중 | 준비 중 |

Windows에서는 macOS의 접근 제한 장치 없이 실행합니다. 도구 차단이 뚫리면 Codex가 PC의 파일을 읽거나 바꿀 수 있습니다.

<details>
<summary>macOS에서 AI 연결하기</summary>

**1. CLI를 설치합니다.**

- Codex: [공식 안내](https://developers.openai.com/codex/cli/)대로 설치하고 ChatGPT 계정으로 로그인합니다.
- Antigravity: [공식 안내](https://antigravity.google/docs/getting-started)의 CLI 항목에서 `agy` 1.4.12 이상을 설치합니다. 앱에서는 Gemini 모델이 3.8 Flash · High(`gemini-3.8-flash-high`)로 고정됩니다.

앱은 `~/.local/bin`, `~/.npm-global/bin`, `/opt/homebrew/bin`, `/usr/local/bin`에서만 실행 파일을 찾습니다.

**2. Codex는 앱 전용 폴더에서 로그인하고, Gemini는 API 키를 저장합니다.** Codex는 개인 AI 설정과 분리되어 있어서, 터미널에서 이미 로그인했어도 연결되지 않을 수 있습니다.

Codex:

```sh
mkdir -p "$HOME/Library/Application Support/Code Learning/codex-home"
CODEX_HOME="$HOME/Library/Application Support/Code Learning/codex-home" codex login
```

Gemini: Google AI Studio에서 API 키를 만든 뒤 앱 → **질문 → 설정 → Gemini API 키**에 붙여 넣고 **저장**을 누릅니다. 키는 이 컴퓨터에 암호화해 저장하며 Gemini 실행에만 넘깁니다.
앱은 키 저장 또는 Gemini 전송 때만 키체인에 접근하며, Apple 서명이 없어 업데이트 후 Gemini를 처음 실행할 때 macOS가 키체인 접근을 물으면 **허용(또는 항상 허용)**을 선택해 주세요.

Google은 이 앱처럼 Antigravity CLI를 다른 앱에서 실행하는 방식에 개인 Google 로그인을 허용하지 않고, 어기면 Antigravity·Gemini CLI 이용이 정지될 수 있어 API 키만 사용합니다([Antigravity FAQ](https://antigravity.google/docs/faq)). 무료 등급 키로 보낸 코드와 질문은 Google이 제품 개선에 쓸 수 있습니다. 기존 사용자가 앱 폴더에 남긴 Google 로그인은 더 이상 사용하지 않습니다.

**3. 앱에서 질문합니다.** 위쪽 **질문**을 누르면 설치 확인이 시작되고, 질문 칸의 **설정**에서 방식을 고릅니다. **코드 읽기**에서 함수나 구문을 고른 뒤 질문을 쓰고, **무엇을 보내나요?**를 확인한 다음 전송에 동의합니다.

설치 확인은 실행 파일과 버전만 봅니다. 로그인이 안 됐거나 이용 한도를 넘으면 요청이 실패합니다.

</details>

<details>
<summary>Windows에서 AI 연결하기 (실험 기능)</summary>

Codex만 쓸 수 있고, 실제 Windows PC에서는 확인하지 못했습니다. macOS의 접근 제한 장치 없이 실행하므로 도구 차단이 뚫리면 Codex가 PC의 파일을 읽거나 바꿀 수 있습니다.

**1. Node.js와 Codex를 설치합니다.** Node.js는 공식 설치 프로그램으로 `C:\Program Files\nodejs`에, Codex는 `npm install -g @openai/codex`로 기본 위치인 `%APPDATA%\npm`에 설치합니다. 앱은 이 위치에서만 찾습니다.

**2. PowerShell에서 앱 전용 폴더를 만들고 한 번 로그인합니다.**

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\Code Learning\codex-home" | Out-Null
$env:CODEX_HOME="$env:APPDATA\Code Learning\codex-home"; codex login
```

**3. 질문 칸 → 설정에서 Codex를 고릅니다.** 보낼 자료를 확인하고 동의하면 질문·파일 설명·기능 정리·AI 개요·기획 대조를 쓸 수 있습니다.

설치 확인은 실행 파일과 버전만 봅니다. 로그인이 안 됐거나 이용 한도를 넘으면 요청이 실패합니다. Gemini는 Windows에서 쓸 수 없습니다.

</details>

## 안전과 개인정보

- 지도 내보내기는 버튼을 누를 때만, 고른 위치(열어 둔 프로젝트 폴더 밖)에 `.md` 파일 하나를 쓰거나 클립보드에 넣습니다.
- 프로젝트 파일을 바꾸지 않고, 프로젝트의 코드·설정·스크립트를 실행하지 않습니다.
- AI를 쓰지 않으면 코드는 밖으로 나가지 않습니다. 사용 기록 수집(텔레메트리)도 없습니다.
- AI에 보낸 자료는 고른 회사의 약관과 계정 설정에 따라 처리되며 학습에 쓰일 수 있습니다.
- 새 버전 확인은 앱 설정(톱니 버튼)에서 **새 버전 확인**을 누를 때만 GitHub(`api.github.com`)에 한 번 물어봅니다. 자동 확인, 자동 설치는 없고 프로젝트 정보도 보내지 않습니다.
- AI에 보내기 전에 흔한 비밀값 형태를 `[MASKED_SECRET]` 등으로 가리지만, 모두 찾아낸다고 보장하지는 않습니다.
- Codex와 Gemini는 앱 전용 폴더와 임시 폴더에서 실행하고, macOS에서는 접근 제한 장치(`sandbox-exec`) 안에서만 실행합니다. 이 장치를 쓸 수 없으면 실행하지 않습니다. 설치 확인 때 Claude Code의 버전 확인(`--version`)만은 이 장치 없이 실행합니다.
- 도구 차단은 시험한 범위에서만 확인했고, 네트워크 전송은 막지 않습니다. Windows의 Codex는 접근 제한 장치 없이 실행합니다. 자세한 내용은 [개발 문서의 알려진 한계](docs/development.md#알려진-한계)에 있습니다.
- 최근 프로젝트, 학습 위치와 메모, AI 결과는 `learning.sqlite`에, 화면·코드 색 설정은 `view-settings.json`에 저장합니다. 위치는 macOS가 `~/Library/Application Support/Code Learning/`, Windows가 `%APPDATA%\Code Learning\`입니다. AI CLI가 앱 전용 폴더에 남기는 기록의 보관·삭제 정책은 아직 확인하지 못했습니다.

## 알려진 한계

- 코드 분석은 TypeScript·JavaScript가 중심입니다. Python은 코드 읽기, 프로젝트 지도의 import 연결과 FastAPI·Flask·Django 처리 함수까지의 기능 흐름을 지원하고, Java·Go·Rust 등 다른 언어 파일과 문서 같은 일부 텍스트 파일은 원문으로만 읽을 수 있습니다.
- Python 지도는 점으로 시작하는 상대 import와 자기 패키지 이름으로 시작하는 import만 확실한 선으로 잇습니다. 그 밖의 import는 실행 방법·Python 버전·설치된 패키지에 따라 달라져 후보 파일로 가는 추정 선(촘촘한 점선)으로 그리며 틀릴 수 있습니다. importlib처럼 실행할 때 정해지는 import는 따라가지 못합니다. 소스 파일 옆의 컴파일된 모듈, sys.modules를 직접 바꾸는 코드처럼 코드에 적힌 import 문 밖에서 정해지는 것도 보지 못합니다. 표준 라이브러리 이름은 Python 3.10~3.14를 기준으로 합니다.
- FastAPI·Flask는 모듈 맨 위에서 만든 앱·라우터·Blueprint의 주소 데코레이터만 읽습니다. `APIRouter`의 `prefix`와 `Blueprint`의 `url_prefix`는 같은 파일의 글자만 붙이며 `include_router`·`register_blueprint`에서 붙이거나 바꾸는 앞 경로는 몰라 추정으로 잇습니다. 값 모양 주소(`<int:id>`, `{id:int}` 등)도 `값 모양 모름` 추정으로 잇고 확실한 연결 수에서 뺍니다. 실제 값이 맞는지는 검사하지 않습니다. 특수하거나 글이 섞인 주소 칸, 읽지 못한 방식·요청을 바꾸는 설정, 동적 이름·속성·주소 규칙 변경이 있는 파일은 목록에만 남깁니다. 목록의 Python 파일 가운데 `fastapi.py`·`flask.py` 또는 `fastapi/__init__.py`·`flask/__init__.py`가 있으면 해당 프레임워크만 연결을 막습니다(가상 환경의 `site-packages`·`dist-packages` 제외). 이름만 같은 폴더는 막지 않습니다. Python 처리 함수 안의 호출, `app.mount`, 함수 안에서 만든 앱, 다른 파일에서 가져온 앱·라우터, Flask·Blueprint를 상속한 클래스의 인스턴스, `add_url_rule`·클래스 뷰·중첩 Blueprint 연결은 따라가지 않습니다.
- Django는 모듈 맨 위 `urlpatterns` 리스트의 `path`·`re_path` 가운데 처리 함수를 확정한 주소만 보여 줍니다. 같은 파일의 함수나 확정된 import로 닿는 함수·클래스의 직접 정의된 `get`·`post`·`put`·`patch`·`delete` 메서드를 찾습니다. `include`·`ROOT_URLCONF`의 앞 경로를 따라가지 않아 모든 연결이 추정이며, 글자 칸 없는 주소는 잇지 않습니다. `re_path`는 목록에만 남기고 정규식은 맞추지 않습니다. DRF 라우터, 물려받은 메서드만 있는 제네릭 클래스 뷰, 옛 `url()`·`i18n_patterns`는 읽지 않습니다. import 장치·별표 import·구문 오류가 있는 파일의 뷰는 확정하지 않고, 동적 변경 파일의 주소와 프로젝트의 `django.py`·`django/__init__.py`가 가리는 Django 주소는 요청과 잇지 않습니다.
- 앞부분을 모르는 주소는 글자 칸이 하나라도 있어야 요청과 잇고, 글자 칸이 없는 `/`·`/:id` 같은 주소는 목록에만 남기며 알림으로 안내합니다.
- 기능 흐름의 요청 경로는 기존 규칙대로 연속된 `/`와 끝의 `/`를 정리합니다. 실제 서버가 두 요청을 같게 처리하는지는 확인하지 않습니다.
- Python 문법 검사는 하지 않습니다. 들여쓰기가 어긋난 코드처럼 Python이 실행을 거부하는 코드도 일부는 오류 표시 없이 보일 수 있습니다.
- 연결은 주소 문자열과 코드 모양으로 찾습니다. 실제로 실행해서 확인한 결과가 아닙니다.
- 경로 별칭(`@/…` 등)은 일부만 지원합니다. Fastify·Hono·Koa 등은 기능 흐름 분석 대상이 아닙니다.
- AI 답과 기획 대조는 틀릴 수 있고, 다른 AI가 교차 확인하지도 않습니다. 근거 코드가 바뀌면 다시 확인해야 하며, 오래된 근거로는 이동하지 않습니다.
- Windows의 AI는 Codex만 되는 실험 기능이고, 실제 Windows PC에서 확인하지 못했습니다.
- macOS에서 AI는 IPv4로만 연결합니다. IPv6만 쓰는 네트워크에서는 AI가 연결되지 않을 수 있습니다.
- AI 요청을 취소하거나 시간이 초과돼도, AI 프로그램이 띄운 하위 프로세스가 남을 수 있습니다. Windows에서 `taskkill`이 실패하거나 2초 안에 끝나지 않는 경우, CLI가 하위 프로세스를 분리해 두고 먼저 종료하는 경우입니다.
- CLI가 업데이트되면 AI 동작과 도구 제한이 달라질 수 있습니다.

## 개발

macOS Apple silicon, Node.js 24 기준입니다. 저장소 폴더에서 실행합니다.

```sh
npm ci
npm start
```

검증은 아래 순서로 합니다. 화면 시험은 서로 영향을 주지 않도록 하나씩 실행하세요.

```sh
npm run typecheck
npm test
npm run package
npm run test:electron
npm run test:packaged
```

설치 파일은 macOS에서 `npm run make`(결과 `out/make/Code-Learning-mac-arm64.dmg`), Windows에서 `npm run make:win`(결과 `out/make/squirrel.windows/x64/Code-Learning-win-x64-Setup.exe`)으로 만듭니다.

구조와 추가 검증은 [개발 문서](docs/development.md), 시험 기록은 [구현 상태](docs/implementation-status.md)에 있습니다.

## 라이선스

[MIT](LICENSE)
