# Code Learning 1.1.0

2026-11-14(KST) [GitHub에 공개했습니다](https://github.com/ckdgus222/code-learning/releases/tag/v1.1.0).

Python 프로젝트를 읽고 서버 주소까지 따라갈 수 있으며, 파일 사이의 관계를 찾고 공유하는 기능을 더했습니다.

## 새 기능

- **Python 코드 읽기:** 함수·메서드·클래스·import 목록, 코드 색칠, 함수 안 구문 단계와 해당 줄을 볼 수 있습니다.
- **Python 프로젝트 지도:** 파일 사이의 import 관계를 표시합니다. 확정하지 못한 연결은 후보마다 ‘추정’으로 구분합니다.
- **FastAPI·Flask·Django:** 코드에 적힌 서버 주소와 처리 함수를 찾아 프론트 요청에서 Python 처리 함수까지 연결합니다. Django는 읽을 수 있는 `include`와 `ROOT_URLCONF` 설정을 따라 전체 주소를 잇습니다.
- **이름 검색과 탐색:** 파일 검색 칸에서 TS/JS·Python의 함수·클래스 이름도 찾습니다. 두 파일 사이의 가장 짧은 import 경로, 읽는 순서 추천, 서로 순환해서 가져다 쓰는 파일 묶음을 볼 수 있습니다.
- **변경 영향 보기(macOS):** 바뀐 파일을 직접 가져다 쓰는 파일과, 삭제·이름 변경 전 경로를 여전히 참조하는 TS/JS import를 찾습니다. 삭제된 파일 참조는 상대 경로와 `paths` 별칭을 확인합니다.
- **지도 내보내기:** 프로젝트 지도 요약과 폴더 그림을 Markdown으로 저장하거나 복사합니다. 파일 저장은 열어 둔 프로젝트 밖의 `.md` 파일로 제한합니다.
- **더 많은 원문 보기:** Go·Rust·Kotlin·C#·Ruby·PHP·Swift·C/C++·Vue·Svelte 등의 파일도 텍스트로 열 수 있습니다.

## 개선

- 주석이나 같은 이름의 호출·대입이 많이 이어지는 파일에서 분석이 오래 걸리는 문제를 줄였습니다. 너무 깊게 중첩된 파일은 구조 분석을 생략하고 이유를 표시합니다.
- 큰 프로젝트 지도의 결과 크기를 제한하고, 일부만 읽거나 연결을 찾지 못한 경우를 알립니다.
- 로컬에서 만든 앱에 테스트 캐시와 그 안의 개발 환경 경로가 포함되지 않도록 패키징을 수정했습니다.
- README에서 지원 범위와 알려진 한계를 쉽게 찾을 수 있도록 정리했습니다.

## 지원 범위와 한계

- Python의 함수 안 호출·값 추적·파일 안내는 아직 지원하지 않습니다. 기능 흐름은 Python 처리 함수에서 끝납니다.
- 라우터·블루프린트의 앞 경로, 함수 안에서 만든 앱, 동적으로 바뀌는 Django 주소 등은 일부만 읽거나 추정으로 남습니다. ‘확실함’도 정적 분석 범위의 판단이며 실제 실행 결과는 아닙니다.
- Java·Spring·Spring Boot 등 추가 언어·프레임워크 분석은 아직 지원하지 않습니다. 지원하는 확장자는 원문만 볼 수 있습니다.
- Windows의 Git 변경 보기는 지원하지 않으며, Windows Codex 연결은 파일 접근 울타리가 없는 미검증 실험 기능입니다.

## 설치 파일

- macOS Apple silicon: `Code-Learning-mac-arm64.dmg`
- Windows x64: `Code-Learning-win-x64-Setup.exe`
- 파일 무결성 확인: `SHA256SUMS.txt`

설치 방법과 서명 관련 안내는 [README](https://github.com/ckdgus222/code-learning#설치), 자세한 분석·AI 한계는 [개발 문서](https://github.com/ckdgus222/code-learning/blob/main/docs/development.md)를 참고하세요.
