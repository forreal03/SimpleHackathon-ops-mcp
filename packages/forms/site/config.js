/*
 * 대회마다 고치는 곳은 이 파일 하나입니다. 질문과 모집 기간은 여기가 아니라
 * apps-script/Config.gs 에 있습니다 (서버가 매 제출마다 같은 기준으로 검사하도록).
 *
 * 여기 값은 모두 방문자에게 그대로 보입니다. 비밀 값은 넣지 마세요.
 * CLIENT_ID 나 ENDPOINT 가 비어 있으면 아무 데도 보내지 않는 미리보기(데모) 모드로 열립니다.
 *
 * 글 안에서 쓸 수 있는 꾸밈: 줄바꿈 \n, **굵게**, [글자](주소)
 * 기간 자리표시: {period} 모집 기간(10.07 – 10.31), {open} 시작(10.07 08:00), {close} 마감(10.31 23:59)
 */
window.SHO_CONFIG = {
  // Google Cloud 콘솔 → Google Auth 플랫폼 → 클라이언트 → 웹 애플리케이션 → 클라이언트 ID
  CLIENT_ID: '',
  // Apps Script → 배포 → 웹 앱 → /exec 로 끝나는 주소
  ENDPOINT: '',
  // 브라우저에 임시 저장본을 둘 때 쓰는 이름. 같은 도메인에서 대회를 여러 번 열면 바꿔 주세요.
  EVENT_ID: 'my-hackathon-2026',

  // 탭 제목
  TITLE: '참가 신청 · My Hackathon',

  // 왼쪽 위 로고 글자. href 를 비우면 이 페이지 맨 위로 갑니다.
  BRAND: { name: 'My Hackathon', sub: 'University Hackathon', href: '' },

  // 헤더 메뉴 (넓은 화면에서만 보입니다). 맨 오른쪽 흰 버튼은 항상 신청서로 갑니다.
  NAV: [
    // { label: '대회 안내', href: 'https://example.github.io/' }
  ],
  APPLY_LABEL: '참가 신청',

  // 페이지 머리
  HEAD: {
    tag: 'Apply',
    title: '참가 신청',
    sub: '로그인을 먼저 해주세요.',
    cta: '신청서 작성하기',
    links: [
      // { label: '대회 안내', href: 'https://example.github.io/' }
    ]
  },
  // 머리 오른쪽 세 칸
  STATS: [
    { label: '모집 기간', value: '{period}' },
    { label: '팀 규모', value: '팀당 2~6명' },
    { label: '정원', value: '최대 120명' }
  ],

  STEPS: {
    tag: 'Steps',
    title: '신청 과정',
    items: [
      { time: 'STEP 1', title: '신청서 제출', text: '구글 로그인 후 이 페이지에서 바로 제출합니다. {close}까지 받습니다. 팀이 있다면 조장이 “조장 ㅇㅇㅇ”으로 표기해 주세요.' },
      { time: 'STEP 2', title: '팀 매칭', text: '팀 없이 신청하신 분은 운영진이 희망 역할을 보고 팀을 맺어 드립니다.' },
      { time: 'STEP 3', title: '팀 확정 · GitHub 초대', text: '팀이 확정되면 적어 주신 **GitHub 아이디**로 대회 organization과 팀 repository 초대가 갑니다. 메일의 초대를 꼭 수락해 주세요.' },
      { time: 'STEP 4', title: '본 해커톤', text: '날짜와 장소는 확정되는 대로 안내합니다.' }
    ]
  },

  NOTICES: {
    tag: 'Notice',
    title: '유의사항',
    items: [
      { time: '참가 자격', title: '참가 자격을 확인해 주세요', text: '대회 안내에 적힌 참가 자격을 갖춘 분만 신청하실 수 있습니다.' },
      { time: '중복 제출 금지', title: '이미 낸 작품은 결과물로 낼 수 없습니다', text: '다른 대회나 수업에 낸 작품, 또는 그와 사실상 같은 작품은 결과물로 낼 수 없습니다.' },
      { time: '개인정보', title: '행사가 끝나면 파기합니다', text: '신청서의 개인정보는 행사 운영에만 쓰고, 행사가 끝나면 파기합니다. 신청 정보는 운영진만 볼 수 있습니다.' }
    ]
  },

  FORM_HEAD: { tag: 'Form', title: '신청서 작성' },

  // 제출을 마친 뒤 화면. links 는 아래쪽 버튼, recap 은 요약에 보일 질문 key (비우면 앞에서부터 알아서 고름)
  DONE: {
    title: '신청이 접수되었습니다',
    text: '신청해주셔서 감사합니다.',
    links: [],
    recap: []
  },

  // 모집 기간 밖에 신청서 자리에 뜨는 안내. 비워 두면 기본 문구를 씁니다.
  GATE_TEXT: {
    before: { title: '', text: '' },
    after: { title: '', text: '' }
  },

  // 약관·개인정보처리방침 주소. 비우면 링크를 숨기고, 제출 버튼 옆에는 Config.gs 의 EVENT.privacy 가 뜹니다.
  LEGAL: { terms: '', privacy: '' },

  FOOTER: {
    lines: ['My University 해커톤', '주관 동아리 A · B · C'],
    // kind: github | mail | link
    links: [
      // { kind: 'github', href: 'https://github.com/your-org', label: 'GitHub' },
      // { kind: 'mail', href: 'mailto:hackathon@example.com', label: '문의 메일' }
    ],
    hosts: [
      // { label: '주최', items: [{ text: 'My University', href: 'https://example.ac.kr' }, { text: 'Department of CS' }] }
    ]
  }
};
