# Code Learning 1.2.0

프론트엔드 요청에서 Java의 Spring 처리 메서드로 이동하고, Python에서는 서버 처리 함수 안에서 부르는 함수와 값의 출처까지 따라갈 수 있습니다.

## Java와 Spring Boot

- Java 파일에서 메서드·생성자·클래스·인터페이스·import를 고르면 해당 코드로 이동합니다. 메서드 안의 조건과 반복도 단계별로 볼 수 있습니다.
- Spring MVC 컨트롤러의 주소를 찾아 `fetch`·`axios` 요청과 연결합니다. Spring Boot 설정의 `/api`와 `/v1`, 컨트롤러의 `/orders`를 합쳐 `/api/v1/orders`의 처리 메서드를 여는 식입니다.
- 프로필별 설정, 환경 변수, 추가 요청 조건으로 결과가 달라질 수 있으면 추정으로 표시합니다. Java의 기능 흐름은 처리 메서드에서 끝납니다.

## Python

- 함수의 직접 호출, 다른 파일에서 가져온 함수, 위치·키워드 인자와 값이 적힌 곳을 따라갑니다. 타입으로 찾은 메서드는 후보로 구분합니다. 파일을 열면 주요 코드를 묶어 볼 수 있고, 선택한 파일의 AI 설명을 요청할 수 있습니다.
- FastAPI·Flask의 앱 생성 함수, 라우터·블루프린트 등록, Django REST Framework의 기본 라우터·추가 액션 등에서 더 많은 서버 주소를 찾습니다. Django에서 처리 함수를 찾지 못해도 원래 주소 선언과 그 줄을 확인할 수 있습니다.

## 설치

macOS Apple silicon은 `Code-Learning-mac-arm64.dmg`, Windows x64는 `Code-Learning-win-x64-Setup.exe`를 받으세요. 두 파일의 SHA-256은 함께 제공하는 `SHA256SUMS.txt`에서 확인할 수 있습니다. [설치 안내](https://github.com/ckdgus222/code-learning/tree/v1.2.0#설치)
