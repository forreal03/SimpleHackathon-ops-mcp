/*
 * Questions used in demo mode (config.js empty). Mirrors the defaults in apps-script/Config.gs,
 * in the shape the server's ?form=1 returns. The live page always uses the server's questions.
 */
window.SHO_DEMO_FORM = (function () {
  function f(key, type, extra) {
    var o = { key: key, type: type, required: false, placeholder: '', options: [], solo: [], chips: [], max: type === 'textarea' ? 2000 : 200, full: false };
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  return {
    ok: true,
    api: 1,
    event: {
      title: 'My Hackathon 2026 — 참가 신청',
      intro: '구글 계정으로 로그인한 뒤 작성해 주세요. 제출한 내용은 마감 전까지 다시 열어 고칠 수 있습니다.',
      privacy: '입력하신 정보는 대회 운영에만 쓰이며 대회 종료 후 파기됩니다.',
      privacyUrl: ''
    },
    gate: { state: 'open', openAt: null, closeAt: null },
    sections: [
      { name: '기본 정보', hint: '', optional: false, fields: [
        f('성함', 'text', { required: true, placeholder: '홍길동' }),
        f('연락처', 'tel', { required: true, placeholder: '010-0000-0000' }),
        f('학번', 'text', { required: true, placeholder: '26101234', max: 20 }),
        f('학년', 'single', { required: true, options: ['1학년', '2학년', '3학년', '4학년 이상'], full: true })
      ] },
      { name: 'GitHub 아이디', hint: '팀 repository 초대에 씁니다. github.com/아이디 의 그 아이디를 적어주세요.\n계정이 없다면 https://github.com/signup 에서 만든 뒤 적어주세요.', optional: false, fields: [
        f('GitHub 아이디', 'github', { required: true, placeholder: 'octocat' })
      ] },
      { name: '소속', hint: '두 곳 이상이면 모두 고르세요.', optional: false, fields: [
        f('소속', 'multi', { required: true, options: ['동아리 A', '동아리 B', '동아리 C'], solo: ['소속 없음'] })
      ] },
      { name: '희망 역할', hint: '골라 넣거나 직접 적으셔도 됩니다.', optional: false, fields: [
        f('희망역할', 'text', { required: true, placeholder: '예) 백엔드, 기획', chips: ['프론트엔드', '백엔드', '풀스택', '데이터', 'AI/모델', '디자인', '기획'] })
      ] },
      { name: '기술 스택 및 개발 경험', hint: '실력은 상관없습니다. 포트폴리오 링크만 남겨도 됩니다.', optional: false, fields: [
        f('기술스택 및 개발 경험', 'textarea', { required: true, placeholder: '써 본 언어·프레임워크, 해 본 프로젝트' })
      ] },
      { name: '팀', hint: '이미 팀이 있으면 조장과 팀원 이름을 적어주세요. 팀이 없으면 "없음" — 운영진이 매칭합니다.', optional: false, fields: [
        f('팀 보유 여부 및 팀원', 'textarea', { required: true, placeholder: '예) 조장 홍길동 / 김철수, 이영희' })
      ] },
      { name: '일정', hint: '참석이 어려운 날을 고르세요.', optional: false, fields: [
        f('참석 불가 일정', 'multi', { required: true, options: ['사전 교육', '중간 점검'], solo: ['모든 일정 참석 가능'] })
      ] },
      { name: '기타', hint: '', optional: true, fields: [
        f('기타', 'textarea', { placeholder: '운영진에게 하고 싶은 말' })
      ] }
    ]
  };
})();
