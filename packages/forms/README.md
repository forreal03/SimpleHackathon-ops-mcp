# 신청 폼 (forms)

해커톤 참가 신청을 받는 웹 페이지와 그 백엔드입니다. [ENDPoinT 2026](https://2026endpoint.github.io) 사이트의 신청서를 대회와 상관없이 쓸 수 있게 떼어 낸 것입니다.

- **사이트** (`site/`): 정적 HTML·CSS·JS. 빌드 없이 GitHub Pages에 올립니다.
- **백엔드** (`apps-script/`): 구글 시트에 붙은 Google Apps Script 웹 앱. 답을 검사해 시트에 한 사람 한 줄로 씁니다.
- 질문과 모집 기간은 **`apps-script/Config.gs` 한 곳**에만 있습니다. 사이트는 서버에서 질문을 받아 그리므로 대회마다 사이트를 고칠 필요가 없습니다.
- **GitHub 아이디**를 기본 질문으로 받습니다. 형식이 틀리면 브라우저와 서버 양쪽에서 막고, 입력하는 동안 `github.com/아이디` 링크로 본인 계정이 맞는지 확인하게 합니다.
- 시트의 열 이름(`이메일`, `성함`, `GitHub 아이디`)은 [MCP 서버](../mcp)의 기본 설정과 같아서, MCP가 이 시트를 바로 명단으로 읽습니다.

## 안전장치

| 장치 | 내용 |
| --- | --- |
| 로그인 확인 | 구글 로그인 ID 토큰을 요청마다 구글에 확인합니다(이 사이트용인지, 이메일 인증, 만료). 이메일은 폼 입력이 아니라 토큰에서 가져옵니다. |
| 모집 기간 | 페이지뿐 아니라 **서버가 매 제출마다** 확인합니다. 주소를 알아도 기간 밖에는 저장되지 않습니다. |
| 입력 검사 | 필수, 길이, 보기 목록, 전화번호, GitHub 아이디 형식을 서버가 다시 검사합니다. 설정에 없는 항목은 버려서 참가자가 열을 늘릴 수 없습니다. |
| 시트 보호 | 모든 칸을 텍스트로 쓰고 앞의 `=`를 지워 수식으로 실행되지 않습니다. |
| 중복 방지 | 응답이 끊겨 다시 보낸 제출은 한 번만 처리하고, 동시 제출은 잠금으로 줄 세웁니다. |
| 화면 | 서버나 참가자가 보낸 글자를 HTML로 해석하지 않습니다(DOM API만 사용). |
| 권한 최소 | 스크립트는 붙어 있는 시트 하나(`spreadsheets.currentonly`)와 토큰 확인용 외부 요청만 씁니다. |

## 설치

1. **시트와 스크립트**: 응답을 받을 구글 시트를 만들고 *확장 프로그램 → Apps Script*를 엽니다. `Code.gs`, `Config.gs`를 붙여 넣고, *프로젝트 설정 → "appsscript.json 표시"*를 켠 뒤 [`appsscript.json`](apps-script/appsscript.json)도 그대로 붙여 넣습니다. ([clasp](https://github.com/google/clasp)로 `apps-script/`를 그대로 올려도 됩니다.)
2. **질문 고치기**: `Config.gs`의 `EVENT`(제목·안내), `GATE`(모집 시작·마감), `FORM`(질문)을 대회에 맞게 고칩니다.
3. **로그인 클라이언트**: [Google Cloud 콘솔](https://console.cloud.google.com) → *Google Auth 플랫폼 → 클라이언트 → 웹 애플리케이션*. *승인된 JavaScript 원본*에 사이트 주소(예: `https://your-org.github.io`)와 로컬 확인용 `http://localhost:8000`을 넣습니다. 범위는 기본(`openid email profile`)만 쓰므로 앱 심사가 필요 없습니다. *대상*을 프로덕션으로 바꿔야 테스트 사용자 100명 제한이 풀립니다.
4. **스크립트 속성**: *프로젝트 설정 → 스크립트 속성*에 `CLIENT_ID`(3번의 클라이언트 ID)를 넣습니다. 특정 학교 계정만 받으려면 `ALLOWED_DOMAIN`(예: `example.ac.kr`)도 넣습니다.
5. **준비 실행**: 편집기에서 `setup`을 한 번 실행해 권한을 승인합니다. 응답 탭과 머리글 행이 만들어집니다.
6. **배포**: *배포 → 새 배포 → 웹 앱*, 실행 사용자 *나*, 액세스 *모든 사용자*. 나온 `/exec` 주소를 복사합니다. 코드를 고치면 *배포 관리 → 새 버전*으로 다시 배포해야 반영됩니다.
7. **사이트**: [`site/config.js`](site/config.js)에 `CLIENT_ID`와 `ENDPOINT`(6번 주소)를 넣고, `site/` 폴더를 GitHub Pages로 올립니다.
8. **확인**: 사이트에서 로그인 → 제출 → 시트에 한 줄이 생기는지 봅니다. 같은 계정으로 다시 들어오면 제출한 내용이 채워져 고칠 수 있습니다.

다른 시트에 쓰려면(스크립트를 시트에 붙이지 않을 때) 스크립트 속성 `SHEET_ID`를 넣고, `appsscript.json`의 `spreadsheets.currentonly`를 `spreadsheets`로 바꿉니다.

## 미리보기

`config.js`가 비어 있으면 **데모 모드**로 열립니다. 아무 데도 보내지 않고, 기본 질문으로 화면과 검사를 확인할 수 있습니다.

```bash
cd packages/forms/site && python -m http.server 8000   # http://localhost:8000
```

## 질문 형식

`Config.gs`의 `FORM`은 섹션 목록이고, 각 섹션에 `fields`가 있습니다.

| type | 화면 | 서버 검사 |
| --- | --- | --- |
| `text` | 한 줄 입력. `chips`가 있으면 누르면 붙는 빠른 입력 버튼 | 길이(기본 200) |
| `tel` | 전화번호 | 숫자·`+-()`·공백 7~20자 |
| `textarea` | 여러 줄 | 길이(기본 2000) |
| `single` | 하나만 고르는 버튼 | `options` 안에 있는지 |
| `multi` | 여러 개 고르는 버튼. `solo`의 보기는 고르면 나머지가 풀림(예: "없음") | 보기 안인지, `solo`와 함께 골랐는지 |
| `github` | GitHub 아이디. `@아이디`·프로필 주소도 받아 아이디만 저장 | GitHub 아이디 규칙 |

공통: `key`(시트 열 이름), `required`, `placeholder`, `max`, `full`(두 칸 차지). `제출시각`, `이메일`, `계정 식별자`는 서버가 채우는 열이라 `key`로 쓸 수 없습니다.

## MCP와 연결

[MCP 서버](../mcp)의 `event.yaml`에서 명단을 이 시트로 지정하면 됩니다.

```yaml
roster:
  source: google_sheets
  spreadsheet: "https://docs.google.com/spreadsheets/d/<이 시트>/edit"
  participants_tab: 웹신청          # Config.gs 의 SHEET.name
  columns: { email: 이메일, name: 성함, google_sub: 계정 식별자, github_login: GitHub 아이디 }
```

## 테스트

```bash
# packages/forms 에서
npm test     # Apps Script를 가짜 시트 위에서 실행 + 페이지를 jsdom 데모 모드로 실행
```

## 개인정보

신청서에는 이름·연락처 같은 개인정보가 들어갑니다. 시트는 운영진에게만 공유하고, 대회가 끝나면 안내한 대로 지우세요.
