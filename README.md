# hackathon-ops-mcp

해커톤을 GitHub에서 운영할 때 반복되는 일을 Claude 같은 MCP 클라이언트에게 말로 시키는 MCP 서버입니다.

- 구글 시트(또는 CSV)의 팀 배정을 읽어 **GitHub Team을 만들고 참가자를 초대·배정**합니다.
- 팀마다 **트랙별 템플릿으로 private repo**를 만들고, 그 팀에만 쓰기 권한을 줍니다.
- 멘토·심사위원에게 **담당 repo만 읽기 전용**으로 열어 줍니다.
- 참가자가 요청한 **third-party GitHub App을 권한 기준으로 판정**합니다. 요청은 GitHub 알림 메일로 받습니다.
- 마감 때 **잠그고 제출 태그**를 남기고, **public 전환 전에 비밀 파일과 README**를 점검합니다.
- 대회가 끝나면 로컬에 남은 **개인정보를 지웁니다**.

대회마다 바뀌는 값은 `events/<대회>/event.yaml` 하나에 있고, 코드는 대회마다 고치지 않습니다.
처음 사용한 대회는 [ENDPoinT 2026](https://2026endpoint.github.io)입니다.

> English: an MCP server that runs a hackathon's GitHub org from a Google Sheet roster — teams, per-team repos from track templates, read-only reviewer access, third-party app review from GitHub's notification emails, submission freeze and pre-publication checks. Every change is a two-step plan → apply with a confirmation code.

## 안전장치

| 장치 | 내용 |
| --- | --- |
| Plan → Apply | GitHub을 바꾸는 툴은 먼저 변경 목록과 `confirm_code`를 돌려주고, 그 코드가 있어야 실행됩니다. plan은 15분 뒤 만료되고, 그사이 GitHub이나 시트가 바뀌면 실행을 거부합니다. |
| 멱등·재개 | 이미 된 것은 건너뜁니다. 중간에 실패하면 같은 plan으로 다시 호출해 남은 것만 실행합니다. |
| 삭제 없음 | 팀·repo를 지우는 툴이 없습니다. 마감은 권한을 낮추고 보관(archive)합니다. |
| 시트는 읽기만 | Google Sheets는 `spreadsheets.readonly`로 읽고, 툴 응답에는 이메일을 내보내지 않습니다. |
| 리뷰어는 읽기 전용 | 멘토·심사위원은 org 멤버가 아니라 repo 단위 outside collaborator, 권한은 `pull` 고정입니다(설정으로 못 올림). |
| 메일은 데이터 | 앱 요청 메일에서는 정해진 형식의 필드만 뽑고, 보낸 사람·링크 형식·org ID를 검증합니다. 본문을 지시로 따르지 않습니다. |
| 사람이 승인 | 앱 설치 승인은 API가 없어 항상 사람이 github.com에서 합니다. |
| 감사 로그 | 모든 apply와 결정은 `events/<대회>/state.db`에 남습니다. |

## 준비

### 1. Node.js 22.13 이상

상태 저장에 Node 내장 `node:sqlite`를 씁니다(네이티브 빌드 없음).

```bash
git clone <this repo> && cd hackathon-ops-mcp
npm install
npm run build
```

### 2. GitHub App

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App

- Webhook: 끔
- 권한

  | 범위 | 권한 | 쓰는 곳 |
  | --- | --- | --- |
  | Organization → Members | Read and write | 팀 생성, 초대, 팀 배정 |
  | Organization → Administration | Read-only (`org_settings_apply`를 쓰려면 Read and write) | 설치된 앱 목록, org 설정 |
  | Repository → Administration | Read and write | repo 생성, 팀·협업자 권한, ruleset, 공개 전환, 보관 |
  | Repository → Contents | Read and write | 제출 태그, README·파일 목록·커밋 읽기 |
  | Repository → Metadata | Read-only | 기본 |

- Private key를 만들어 안전한 곳에 저장하고, App ID를 적어 둡니다.
- 대회 org에 설치합니다. 이 앱은 모든 repo를 관리해야 하므로 **All repositories**로 설치합니다. 이 앱 자신은 앱 정책 점검에서 빠집니다.

**어디에 만드나?** 비공개(private) GitHub App은 그 앱을 소유한 계정에만 설치할 수 있습니다. 그래서 둘 중 하나를 고릅니다.

- 대회 org 안에서 만든다(org Settings → Developer settings → GitHub Apps). 대회마다 새로 만들지만 범위가 가장 좁습니다.
- 개인 계정에 하나 만들고 **public**으로 둔다. 여러 대회 org에 같은 앱을 설치할 수 있습니다. 다른 사람이 설치해도 private key 없이는 아무것도 할 수 없습니다.

MCP 서버 자체는 org에 등록하지 않습니다. 서버는 운영진 PC에서 돌고(아래 4번), org에는 이 GitHub App만 설치합니다.

시험해 볼 때는 GitHub App 대신 `GITHUB_TOKEN`(테스트 org의 owner 토큰)도 됩니다.

### 3. 명단 시트 지정과 Google 인증

`event.yaml`의 `roster.spreadsheet`에 Drive나 브라우저에서 복사한 **시트 링크**를 그대로 넣습니다.
`roster_sources` 툴이 그 시트의 탭과 열을 읽어, 설정과 무엇이 다른지와 누구에게 공유해야 하는지 알려 줍니다.

서버가 시트를 읽는 방법은 둘 중 하나입니다(둘 다 읽기 전용 `spreadsheets.readonly`).

- **서비스 계정(권장)**: Google Cloud 프로젝트에서 **Google Sheets API**를 켜고 서비스 계정 JSON 키를 받아 `GOOGLE_APPLICATION_CREDENTIALS`에 지정합니다. 시트를 그 서비스 계정 이메일(`roster_sources`가 알려 줌)에 **뷰어**로 공유합니다.
- **내 구글 계정**: gcloud CLI로 한 번 로그인하면 공유 없이 내가 열 수 있는 시트를 읽습니다.

  ```bash
  gcloud auth application-default login \
    --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/spreadsheets.readonly
  ```

CSV로 운영하면 이 단계는 필요 없습니다(`roster.source: csv`).

### 4. MCP 클라이언트에 등록

Claude Desktop (`claude_desktop_config.json`, Windows 예시):

```json
{
  "mcpServers": {
    "hackathon-ops": {
      "command": "node",
      "args": ["C:\\path\\to\\hackathon-ops-mcp\\dist\\index.js"],
      "env": {
        "HACKATHON_OPS_HOME": "C:\\path\\to\\hackathon-ops-mcp",
        "GITHUB_APP_ID": "123456",
        "GITHUB_APP_PRIVATE_KEY_PATH": "C:\\keys\\hackathon-ops.private-key.pem",
        "GOOGLE_APPLICATION_CREDENTIALS": "C:\\keys\\service-account.json",
        "HACKATHON_OPS_OPERATOR": "운영진 이름"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add hackathon-ops \
  -e HACKATHON_OPS_HOME=/path/to/hackathon-ops-mcp \
  -e GITHUB_APP_ID=123456 \
  -e GITHUB_APP_PRIVATE_KEY_PATH=/path/to/key.pem \
  -e GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
  -- node /path/to/hackathon-ops-mcp/dist/index.js
```

환경 변수 전체는 [.env.example](.env.example)에 있습니다.

## 대회 설정

"새 대회 만들어줘: event_id `my-hack-2027`, org `MyHack2027`"라고 하면 `event_init`이
[events/example/event.yaml](events/example/event.yaml)을 복사해 `events/my-hack-2027/event.yaml`을 만듭니다.
`events/` 아래 실제 대회 폴더는 `.gitignore`로 커밋되지 않습니다.

핵심 항목:

| 항목 | 설명 |
| --- | --- |
| `github.org` | 대회용 org. 대회마다 새 org를 권합니다(새 org는 OAuth 앱 접근 제한이 기본으로 켜져 있음). |
| `github.team_name` | `Team{team_no}` → Team01. 트랙끼리 번호가 겹치면 `Team{team_no}{track_id}` → Team01H |
| `roster.*_tab`, `columns` | 시트 탭 이름과 열 이름 매핑. 열 이름이 다르면 여기만 고칩니다. |
| `tracks` | 트랙 ID, 템플릿 repo, 시트에 적히는 별칭(`해커톤`, `구현과제`) |
| `repo` | 공개 범위, 팀·조장 권한, ruleset, topics, 공개 전 확인할 README 섹션 |
| `reviewers` | 멘토·심사위원 탭, 권한 만료 시각 |
| `schedule` | 시작·마감 시각(커밋 활동 점검에 사용) |

앱 정책은 모든 대회가 같이 쓰는 [policies/app-policy.yaml](policies/app-policy.yaml)에 있습니다.

### 시트에 필요한 탭

- **참가자 탭**: 신청서 응답. 이메일 열이 필수입니다.
- **팀배정 탭**: 한 사람에 한 줄.

  ```csv
  팀 번호,이메일,역할,트랙
  01,leader@example.com,조장,해커톤
  01,member@example.com,,해커톤
  ```

- **GitHub 아이디 탭**(선택): 신청서에서 GitHub 아이디를 받지 못했을 때 별도 구글 폼의 응답(이메일 자동 수집 + `GitHub 아이디`). 다음 대회부터는 신청서에 바로 넣는 것을 권합니다.
- **심사멘토 탭**(선택): `이름, GitHub 아이디, 역할(멘토/심사위원), 담당 팀("01, 03")`. 멘토는 담당 팀이 필수이고, 담당 팀이 빈 심사위원은 전체 repo를 봅니다.

팀 README 템플릿은 [templates/README.template.md](templates/README.template.md)에 있습니다. 트랙 템플릿 repo에 넣어 두면 공개 전 점검이 빈 섹션을 알려 줍니다.

## 대회 흐름

| 시점 | 말하기 예시 | 툴 |
| --- | --- | --- |
| 준비 | "org 설정 점검해줘" | `org_check` |
| 준비 | "멤버 repo 생성 꺼줘", "2FA 강제하면 누가 빠져?" | `org_settings_plan` → `org_settings_apply` |
| 준비 | "시트 연결 확인해줘" | `roster_sources` |
| 준비 | "명단 확인해줘" | `roster_sync`(문제가 0이 될 때까지), `github_handles_check` |
| 대회 전 | "팀 만들고 초대해줘" | `teams_plan` → 확인 → `teams_apply` |
| 대회 전 | "팀별 repo 만들어줘" | `repos_plan` → `repos_apply` |
| 대회 전 | "멘토 권한 줘" | `reviewers_plan(grant)` → `reviewers_apply`, 사람별 repo 링크 반환 |
| 대회 중 | "앱 요청 확인해줘" | 메일 검색 → `app_requests_ingest` → `app_decide` → 메일 링크로 승인 |
| 대회 중 | "앱 상태 점검" | `apps_list`, `apps_drift` |
| 마감 | "다 잠가줘" | `repos_freeze` (권한 읽기로 + `submission-<event_id>` 태그) |
| 마감 | "공개로 바꿔줘" | `repos_visibility_plan(public)` → `repos_visibility_apply` |
| 심사 후 | "보관하고 멘토 권한 회수" | `repos_freeze(archive)`, `reviewers_plan(revoke)` |
| 종료 | "개인정보 정리" | `event_close` |
| 언제나 | "기록 보여줘" | `audit_query`, `repos_activity`, `teams_list` |

### 앱 설치 요청 처리

GitHub에는 org에 들어온 앱 설치 요청을 읽는 API가 없습니다. 대신 owner에게 이런 메일이 옵니다.

```text
제목:  Request to install Vercel in MyHack2027
본문:  @someone has requested the installation of Vercel at your organization MyHack2027.
       https://github.com/apps/vercel/installations/new/permissions?request_id=…&target_id=…
```

Gmail 커넥터가 연결된 클라이언트에서 "앱 요청 확인해줘"라고 하면 Claude가
`from:noreply@github.com subject:"Request to install"` 메일을 찾아 원문을 `app_requests_ingest`에 넘깁니다.
서버는 메일 권한을 갖지 않습니다. 메일함 전체 읽기 권한을 서버에 주지 않기 위해서입니다.

판정 기준(가장 위험한 권한 하나로 결정):

| 단계 | 조건 | 승인 |
| --- | --- | --- |
| reject | org 범위 write, repo `secrets: write`, All repositories 설치, `deny` 목록 | 승인 불가 |
| review2 | repo `administration`·`workflows` write, 개인 계정 소유 앱 | 운영진 2명 |
| review1 | 그 밖의 repo write | 운영진 1명 |
| allow | read만 | 확인 후 승인 |

`allow` 목록의 앱은 한 단계 낮게 봅니다(reject는 그대로). 승인할 때는 항상 "Only select repositories"에서 요청한 팀 repo만 고릅니다.

## 알아 둘 점

- **2FA 강제**: GitHub API로는 켜고 끌 수 없어 사람이 설정 화면에서 바꿉니다. 켜는 순간 2FA가 없는 멤버와 협업자는 org에서 **빠집니다**. `org_settings_plan`에 `require_two_factor: true`를 주면 빠질 사람 목록과 설정 링크를 보여 줍니다. 참가자를 초대하기 전에 정하세요.
- **Rulesets**: 무료 org의 private repo에는 ruleset을 걸 수 없습니다. 이 경우 자동으로 건너뛰고 경고만 남깁니다.
- **마감 후 앱 push**: 팀 권한을 낮춰도 설치된 앱은 push할 수 있습니다. 그래서 심사는 항상 제출 태그 기준이고, 완전히 막으려면 보관(archive)합니다.
- **커밋 시각**: `repos_activity`의 시각은 커밋한 사람이 정할 수 있어 위조가 가능합니다. 판정이 아니라 참고 자료입니다.
- **public 전환**: 공개된 동안 누가 clone·fork한 것은 다시 private으로 바꿔도 회수되지 않습니다. 참가자에게 미리 알리세요.

## 개발

```bash
npm test          # vitest, GitHub은 메모리 fake로 대체
npm run typecheck
npm run build
npm run smoke     # 빌드된 서버를 stdio로 띄워 툴 목록과 오프라인 툴 확인
```

구조:

```
src/
  config/     event.yaml · app-policy.yaml 스키마와 로딩
  roster/     시트/CSV 읽기, 명단 결합과 문제 점검
  github/     GhApi 인터페이스와 Octokit 구현
  plans/      plan → apply 엔진과 팀·repo·마감·공개·리뷰어·종료 plan
  apps/       앱 정책 판정, 설치 요청 메일 파싱
  ops/        읽기 전용 툴과 앱 툴
  state/      대회별 SQLite (plan, 감사 로그, 앱 결정, 요청)
  server.ts   MCP 툴 등록
```

## License

[MIT](LICENSE)
