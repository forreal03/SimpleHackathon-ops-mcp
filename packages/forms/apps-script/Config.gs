/**
 * SimpleHackathon forms — what each event changes. The site reads all of this from the server,
 * so the questions live in exactly one place.
 *
 * Secrets do not go here (this file is usually in a public repo). Put them in
 * Apps Script → Project Settings → Script properties:
 *   CLIENT_ID       OAuth client ID of the site (…apps.googleusercontent.com). Required.
 *   SHEET_ID        Spreadsheet to write to. Leave empty when this script is bound to the sheet.
 *   ALLOWED_DOMAIN  e.g. "example.ac.kr" to accept only that Google Workspace domain. Optional.
 */

/**
 * Texts that sit next to the form. Everything else on the page (event name, steps, notices, footer)
 * is in the site's config.js.
 */
var EVENT = {
  /** Under "구글 계정으로 시작하기", before sign-in. */
  intro: '신청자 확인과 중복 제출 방지를 위해 로그인이 필요합니다. 제출한 내용은 마감 전까지 다시 열어 고칠 수 있습니다.',
  /** Next to the submit button when the site has no terms/privacy links (config.js LEGAL). Keep it short. */
  privacy: '입력하신 정보는 대회 운영에만 쓰이며 대회 종료 후 파기됩니다.',
  privacyUrl: ''
};

/**
 * Application period, checked by the server on every submission (not only by the page).
 * ISO time with an offset. Empty = no limit on that side.
 */
var GATE = {
  openAt: '2026-10-07T08:00:00+09:00',
  closeAt: '2026-10-31T23:59:59+09:00'
};

var SHEET = {
  /** Tab that receives the answers. Created with its header row on first use. */
  name: '웹신청',
  /** true: a second submission from the same Google account updates that person's row. */
  updateIfExists: true
};

/**
 * The questions. Each field's `key` is its column in the sheet. The MCP server's event.yaml maps
 * columns by these names (roster.columns), so keep 성함 / GitHub 아이디 or change both sides.
 *
 * Section: name, hint (shown inside, \n = new line, URLs become links), optional, summary
 *          (grey text on the closed header; default: the field names, or "중복 선택 가능"), fields.
 *
 * type     text | tel | textarea | single | multi | github
 * required true makes it mandatory
 * options  choices for single / multi
 * solo     multi only: choices that clear the others (e.g. "없음")
 * chips    text only: quick-fill buttons that append to the text
 * max      maximum length (default 200, textarea 2000)
 * full     takes a full row in the two-column layout
 */
var FORM = [
  {
    name: '기본 정보',
    summary: '성함 · 연락처 · 학번 · 학년',
    fields: [
      { key: '성함', type: 'text', required: true, placeholder: '홍길동' },
      { key: '연락처', type: 'tel', required: true, placeholder: '010-0000-0000' },
      { key: '학번', type: 'text', required: true, placeholder: '26101234', max: 20 },
      { key: '학년', type: 'single', required: true, options: ['1학년', '2학년', '3학년', '4학년 이상'], full: true }
    ]
  },
  {
    name: 'GitHub 아이디',
    hint: '팀 repository 초대에 씁니다. github.com/아이디 의 그 아이디를 적어주세요.\n계정이 없다면 https://github.com/signup 에서 만든 뒤 적어주세요.',
    fields: [
      { key: 'GitHub 아이디', type: 'github', required: true, placeholder: 'octocat' }
    ]
  },
  {
    name: '소속',
    hint: '두 곳 이상이면 모두 고르세요.',
    fields: [
      { key: '소속', type: 'multi', required: true, options: ['동아리 A', '동아리 B', '동아리 C'], solo: ['소속 없음'] }
    ]
  },
  {
    name: '희망 역할',
    hint: '골라 넣거나 직접 적으셔도 됩니다.',
    fields: [
      { key: '희망역할', type: 'text', required: true, placeholder: '예) 백엔드, 기획',
        chips: ['프론트엔드', '백엔드', '풀스택', '데이터', 'AI/모델', '디자인', '기획'] }
    ]
  },
  {
    name: '기술 스택 및 개발 경험',
    hint: '실력은 상관없습니다. 포트폴리오 링크만 남겨도 됩니다.',
    fields: [
      { key: '기술스택 및 개발 경험', type: 'textarea', required: true, placeholder: '써 본 언어·프레임워크, 해 본 프로젝트' }
    ]
  },
  {
    name: '팀',
    hint: '이미 팀이 있으면 조장과 팀원 이름을 적어주세요. 팀이 없으면 "없음" — 운영진이 매칭합니다.',
    fields: [
      { key: '팀 보유 여부 및 팀원', type: 'textarea', required: true, placeholder: '예) 조장 홍길동 / 김철수, 이영희' }
    ]
  },
  {
    name: '일정',
    hint: '참석이 어려운 날을 고르세요.',
    fields: [
      { key: '참석 불가 일정', type: 'multi', required: true, options: ['사전 교육', '중간 점검'], solo: ['모든 일정 참석 가능'] }
    ]
  },
  {
    name: '기타',
    optional: true,
    fields: [
      { key: '기타', type: 'textarea', placeholder: '운영진에게 하고 싶은 말' }
    ]
  }
];
