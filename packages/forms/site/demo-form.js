/*
 * 미리보기(데모) 모드에서 쓰는 질문. config.js 가 비어 있을 때만 쓰인다.
 * apps-script/Config.gs 의 기본값을 서버의 GET ?form=1 응답 모양 그대로 옮긴 것이다
 * (test/site.test.mjs 가 둘이 같은지 확인한다). 실제 사이트는 언제나 서버의 질문을 쓴다.
 */
window.SHO_DEMO_FORM = (function () {
  function f(key, type, extra) {
    var o = { key: key, type: type, required: false, placeholder: '', options: [], solo: [], chips: [], max: type === 'textarea' ? 2000 : 200, full: false };
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  function s(name, fields, extra) {
    var o = { name: name, hint: '', optional: false, summary: '', fields: fields };
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  return {
    ok: true,
    api: 1,
    event: {
      intro: '신청자 확인과 중복 제출 방지를 위해 로그인이 필요합니다. 제출한 내용은 마감 전까지 다시 열어 고칠 수 있습니다.',
      privacy: '입력하신 정보는 대회 운영에만 쓰이며 대회 종료 후 파기됩니다.',
      privacyUrl: ''
    },
    // 데모에서는 날짜와 상관없이 열려 있다 (닫힌 모습은 ?gate=closed · ?gate=after)
    gate: { state: 'open', openAt: '2026-10-07T08:00:00+09:00', closeAt: '2026-10-31T23:59:59+09:00' },
    sections: [
      s('기본 정보', [
        f('성함', 'text', { required: true, placeholder: '홍길동' }),
        f('연락처', 'tel', { required: true, placeholder: '010-0000-0000' }),
        f('학번', 'text', { required: true, placeholder: '26101234', max: 20 }),
        f('학년', 'single', { required: true, options: ['1학년', '2학년', '3학년', '4학년 이상'], full: true })
      ], { summary: '성함 · 연락처 · 학번 · 학년' }),
      s('GitHub 아이디', [
        f('GitHub 아이디', 'github', { required: true, placeholder: 'octocat' })
      ], { hint: '팀 repository 초대에 씁니다. github.com/아이디 의 그 아이디를 적어주세요.\n계정이 없다면 https://github.com/signup 에서 만든 뒤 적어주세요.' }),
      s('소속', [
        f('소속', 'multi', { required: true, options: ['동아리 A', '동아리 B', '동아리 C'], solo: ['소속 없음'] })
      ], { hint: '두 곳 이상이면 모두 고르세요.' }),
      s('희망 역할', [
        f('희망역할', 'text', { required: true, placeholder: '예) 백엔드, 기획', chips: ['프론트엔드', '백엔드', '풀스택', '데이터', 'AI/모델', '디자인', '기획'] })
      ], { hint: '골라 넣거나 직접 적으셔도 됩니다.' }),
      s('기술 스택 및 개발 경험', [
        f('기술스택 및 개발 경험', 'textarea', { required: true, placeholder: '써 본 언어·프레임워크, 해 본 프로젝트' })
      ], { hint: '실력은 상관없습니다. 포트폴리오 링크만 남겨도 됩니다.' }),
      s('팀', [
        f('팀 보유 여부 및 팀원', 'textarea', { required: true, placeholder: '예) 조장 홍길동 / 김철수, 이영희' })
      ], { hint: '이미 팀이 있으면 조장과 팀원 이름을 적어주세요. 팀이 없으면 "없음" — 운영진이 매칭합니다.' }),
      s('일정', [
        f('참석 불가 일정', 'multi', { required: true, options: ['사전 교육', '중간 점검'], solo: ['모든 일정 참석 가능'] })
      ], { hint: '참석이 어려운 날을 고르세요.' }),
      s('기타', [
        f('기타', 'textarea', { placeholder: '운영진에게 하고 싶은 말' })
      ], { optional: true })
    ]
  };
})();
