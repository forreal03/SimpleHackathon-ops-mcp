# config

대회마다 복사해서 쓰는 설정 양식입니다. 실제 값(시트 주소, 키, 참가자 명단)은 여기에 넣지 말고 작업 폴더(`HACKATHON_OPS_HOME`, 저장소 안에서는 git에서 빠지는 `workspace/`)에 둡니다.

| 파일 | 쓰는 곳 | 내용 |
| --- | --- | --- |
| [`event.example.yaml`](event.example.yaml) | MCP | 대회 설정 양식. `event_init`이 `<HOME>/events/<대회>/event.yaml`로 복사합니다. org, 명단(로컬/구글 시트), 팀·repo 이름 규칙, 트랙, 일정 |
| [`app-policy.yaml`](app-policy.yaml) | MCP | third-party GitHub App 판정 기준. 모든 대회가 같이 씁니다(`<HOME>/policies/`로 복사) |
| [`team-readme.template.md`](team-readme.template.md) | 팀 repo | 트랙 템플릿 repo에 넣을 README. public 전환 전에 빈 섹션을 확인합니다 |
| [`.env.example`](.env.example) | MCP | 환경 변수 목록(GitHub App, Google 인증, 작업 폴더) |

신청 폼의 설정은 [`packages/forms/apps-script/Config.gs`](../packages/forms/apps-script/Config.gs)(질문·기간)와 [`packages/forms/site/config.js`](../packages/forms/site/config.js)(로그인 클라이언트 ID·서버 주소)에 있습니다.
