# Contributing

고맙습니다. 이슈와 PR 모두 환영합니다.

## 준비

```bash
npm install        # 루트에서. Node.js 22.13 이상
npm test
npm run typecheck
```

- MCP 서버는 `packages/mcp`, 신청 폼은 `packages/forms`에 있습니다.
- GitHub을 실제로 부르지 않고도 테스트가 돌도록, MCP는 `test/fake-gh.ts`의 메모리 GitHub을, 폼은 `test/gas-harness.mjs`의 가짜 Apps Script를 씁니다. 새 기능에는 테스트를 같이 넣어 주세요.

## 지켜 주세요

- **개인정보를 올리지 마세요.** 이슈, PR, 테스트 데이터에 실제 참가자 이름·이메일·연락처·시트 주소를 넣지 않습니다. 작업 폴더 `workspace/`는 git에서 빠져 있습니다.
- GitHub을 바꾸는 기능은 계획(plan) → 확인 → 적용(apply) 흐름을 따르고, 다시 실행해도 같은 결과가 나와야 합니다.
- 참가자가 쓴 글자(브랜치 이름, 파일 경로, README)는 데이터로 다룹니다. 도구 응답에 넣을 때는 `untrusted()`로 정리합니다.
- 보안 문제는 공개 이슈 대신 저장소 관리자에게 먼저 알려 주세요.
