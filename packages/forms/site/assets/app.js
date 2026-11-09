/*
 * SimpleHackathon forms — 신청 페이지 스크립트.
 *
 * ENDPoinT 2026 사이트(2026endpoint.github.io)의 신청서를 그대로 옮기고, 대회마다 바뀌는 것만 떼어 냈다.
 *   - 화면 문구·브랜드는 config.js (window.SHO_CONFIG)
 *   - 질문과 모집 기간은 서버(apps-script/Config.gs)가 GET ?form=1 로 내려 준다
 *   - config.js 가 비어 있으면 demo-form.js 의 질문으로 미리보기(데모) 모드
 *
 * 순서: 페이지 글 채우기 → 움직임 → 로그인(SHOSession) → 질문 받기 → 모집 기간 판정 → 신청서
 */
(function () {
  'use strict';

  var C = window.SHO_CONFIG || {};
  var DEMO = !C.CLIENT_ID || !C.ENDPOINT;
  var EVENT_ID = String(C.EVENT_ID || 'event').replace(/[^\w.-]/g, '_');

  /* ============================== 공통 ============================== */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function $(id) { return document.getElementById(id); }

  /** 링크로 써도 되는 주소만 돌려준다 (http(s) · mailto · 같은 사이트 안의 경로와 #앵커) */
  function safeHref(h) {
    h = String(h == null ? '' : h).trim();
    if (!h) return '';
    if (/^(https?:|mailto:)/i.test(h)) return h;
    if (/^[a-z][a-z0-9+.-]*:/i.test(h) || /^\/\//.test(h)) return '';
    return h;
  }
  function link(href, text, cls) {
    var a = document.createElement('a');
    var h = safeHref(href);
    if (h) a.href = h;
    if (/^https?:/i.test(h)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    if (cls) a.className = cls;
    a.textContent = text;
    return a;
  }

  /* 기간 자리표시 — 질문을 받아 온 뒤 채운다. 그 전에는 '…' */
  var VARS = { period: '…', open: '…', close: '…' };
  var bound = [];
  function vars(text) {
    return String(text == null ? '' : text).replace(/\{(period|open|close)\}/g, function (_, k) { return VARS[k]; });
  }

  /**
   * config.js 의 글을 DOM 으로 그린다. HTML 로 해석하지 않고 꾸밈 세 가지만 안다:
   * 줄바꿈(\n), **굵게**, [글자](주소). 기간 자리표시가 있으면 나중에 다시 그린다.
   */
  function rich(el, text, keep) {
    if (!el) return el;
    if (!keep && /\{(period|open|close)\}/.test(String(text))) bound.push([el, text]);
    el.textContent = '';
    vars(text).split('\n').forEach(function (line, i) {
      if (i) el.appendChild(document.createElement('br'));
      var re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g, last = 0, m;
      while ((m = re.exec(line))) {
        if (m.index > last) el.appendChild(document.createTextNode(line.slice(last, m.index)));
        if (m[1] != null) {
          var b = document.createElement('strong');
          b.textContent = m[1];
          el.appendChild(b);
        } else {
          el.appendChild(link(m[3], m[2]));
        }
        last = re.lastIndex;
      }
      if (last < line.length) el.appendChild(document.createTextNode(line.slice(last)));
    });
    return el;
  }
  function setVars(v) {
    VARS = v;
    bound.forEach(function (b) { rich(b[0], b[1], true); });
  }
  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) rich(el, text);
    return el;
  }

  /** 'YYYY-MM-DDT…' → '10.07' (적힌 그대로 읽는다. 시간대 변환 없음) */
  function md(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? m[2] + '.' + m[3] : '';
  }
  /** 'YYYY-MM-DDTHH:MM…' → '10.07 08:00' */
  function mdhm(iso) {
    var m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || ''));
    return m ? m[1] + '.' + m[2] + ' ' + m[3] + ':' + m[4] : md(iso);
  }
  function periodOf(g) {
    var a = md(g && g.openAt), b = md(g && g.closeAt);
    if (a && b) return a + ' – ' + b;
    if (b) return '~ ' + b;
    if (a) return a + ' ~';
    return '상시';
  }

  /* ========================= 페이지 글 채우기 ========================= */
  function slot(item, last) {
    var d = h('div', 'slot' + (last ? ' fin' : ''));
    d.setAttribute('data-anim', '');
    d.appendChild(h('time', '', item.time || ''));
    d.appendChild(h('h3', '', item.title || ''));
    d.appendChild(h('p', '', item.text || ''));
    return d;
  }
  function sectionHead(sec, cfg) {
    var lab = sec.querySelector('.head .lab'), ttl = sec.querySelector('.head h2 span span');
    rich(lab, cfg.tag || '');
    rich(ttl, cfg.title || '');
  }
  function fillSlots(id, cfg) {
    var sec = $(id);
    var items = (cfg && cfg.items) || [];
    if (!sec) return;
    if (!items.length) { sec.hidden = true; return; }
    sectionHead(sec, cfg);
    var wrap = sec.querySelector('.wrap');
    items.forEach(function (it, i) { wrap.appendChild(slot(it, i === items.length - 1)); });
  }
  var ICONS = {
    github: '<svg class="ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
    mail: '<svg class="ico" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false"><rect x="3" y="5.5" width="18" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.8 6.6l8.2 6.3 8.2-6.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
  };

  function renderPage() {
    var B = C.BRAND || {};
    if (C.TITLE) document.title = C.TITLE;
    ['brand', 'foot-mark'].forEach(function (id) {
      var m = $(id);
      if (!m) return;
      m.querySelector('b').textContent = B.name || '';
      m.querySelector('span').textContent = B.sub || '';
    });
    if (B.href && safeHref(B.href)) $('brand').href = safeHref(B.href);

    var nav = $('nav'), apply = $('nav-apply');
    (C.NAV || []).forEach(function (n) {
      var a = link(n.href, n.label || '', 'sm-hide');
      nav.insertBefore(a, apply);
    });
    apply.textContent = C.APPLY_LABEL || '참가 신청';

    var H = C.HEAD || {};
    rich($('head-tag'), H.tag || 'Apply');
    rich($('head-title'), H.title || '참가 신청');
    rich($('head-sub'), H.sub || '');
    var cta = $('head-cta');
    cta.querySelector('span').textContent = H.cta || '신청서 작성하기';
    (H.links || []).forEach(function (l) {
      var a = link(l.href, '', 'btn btn-o');
      a.appendChild(h('span', '', l.label || ''));
      cta.appendChild(a);
    });

    var st = $('head-stats');
    var stats = C.STATS || [];
    if (!stats.length) st.hidden = true;
    stats.forEach(function (s) {
      var d = document.createElement('div');
      d.appendChild(h('span', 'lab', s.label || ''));
      d.appendChild(h('b', '', s.value || ''));
      st.appendChild(d);
    });

    fillSlots('steps', C.STEPS);
    fillSlots('notices', C.NOTICES);
    sectionHead($('form'), C.FORM_HEAD || { tag: 'Form', title: '신청서 작성' });

    var F = C.FOOTER || {};
    var lines = $('foot-lines');
    rich(lines, (F.lines || []).join('\n'));
    var fl = $('foot-links');
    (F.links || []).forEach(function (l) {
      var a = link(l.href, '', 'ilink');
      a.innerHTML = ICONS[l.kind] || '';
      a.appendChild(h('span', '', l.label || (l.kind === 'mail' ? '문의 메일' : l.kind === 'github' ? 'GitHub' : l.href)));
      if (l.kind === 'mail') a.removeAttribute('target');
      fl.appendChild(a);
    });
    var hosts = $('foot-hosts');
    (F.hosts || []).forEach(function (row) {
      var d = h('div', 'host');
      d.appendChild(h('span', 'lab', row.label || ''));
      var dept = h('span', 'dept');
      (row.items || []).forEach(function (it, i) {
        if (i) { var bar = h('span', 'dept-bar'); bar.setAttribute('aria-hidden', 'true'); dept.appendChild(bar); }
        var name = h('span', i ? 'dept-sub' : 'dept-name', it.text || '');
        if (it.href && safeHref(it.href)) {
          var a = link(it.href, '', 'dept-link');
          a.appendChild(name);
          dept.appendChild(a);
        } else {
          dept.appendChild(name);
        }
      });
      d.appendChild(dept);
      hosts.appendChild(d);
    });
    var L = C.LEGAL || {};
    var legal = $('foot-legal');
    if (L.privacy) legal.appendChild(link(L.privacy, '개인정보처리방침', 'pp'));
    if (L.terms) legal.appendChild(link(L.terms, '이용약관'));
    if (!legal.childNodes.length) legal.hidden = true;
  }

  /* ============================== 움직임 ============================== */
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var io = null;
  function revealAll() {
    try { qsa('[data-anim]').forEach(function (el) { el.classList.add('in'); }); } catch (e) {}
  }
  function reveal(root) {
    qsa('[data-anim]:not(.in)', root).forEach(function (el) {
      if (io) io.observe(el); else el.classList.add('in');
    });
  }
  function initMotion() {
    // 아래 어디서든 예외가 나도 글은 읽혀야 한다
    window.addEventListener('error', revealAll);
    if ('IntersectionObserver' in window && !reduce) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    }
    reveal(document);

    // 헤더 색을 배경 그라데이션의 현재 밝기에 맞춘다 (23 → 36) + 맨 위 진행 막대
    var bar = $('top-bar'), prog = $('progress'), root = document.documentElement;
    var lastTint = -1, ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      (window.requestAnimationFrame || setTimeout)(function () {
        var y = window.scrollY || 0;
        bar.classList.toggle('scrolled', y > 8);
        var max = document.body.scrollHeight - window.innerHeight;
        var t = max > 0 ? Math.min(y / max, 1) : 0;
        prog.style.transform = 'scaleX(' + t + ')';
        var v = Math.round(23 + (36 - 23) * t);
        if (v !== lastTint) { lastTint = v; root.style.setProperty('--hdr-rgb', v + ',' + v + ',' + v); }
        ticking = false;
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // 한글이 들어간 .lab 에는 .ko 를 붙여 자간을 풀어 준다 — 나중에 그려지는 라벨까지
    var HAN = /[ㄱ-ㆎ가-힣]/;
    function tag(n) {
      if (!n || n.nodeType !== 1) return;
      if (n.classList.contains('lab') && HAN.test(n.textContent)) n.classList.add('ko');
      qsa('.lab', n).forEach(function (l) { if (HAN.test(l.textContent)) l.classList.add('ko'); });
    }
    tag(document.body);
    if ('MutationObserver' in window) {
      new MutationObserver(function (ms) {
        ms.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, tag); });
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  /* ============================== 로딩 표시 ============================== */
  var UI = {
    /** 원형 로딩 표시. cls 에 'sm'(작게) · 'ink'(글자색 따라가기) */
    spin: function (cls) {
      return '<svg class="spin ' + (cls || '') + '" viewBox="0 0 28 28" aria-hidden="true">' +
             '<circle cx="14" cy="14" r="12"></circle></svg>';
    },
    loading: function (text, cls) {
      return '<div class="loading ' + (cls || '') + '" role="status">' +
             this.spin('') + '<span>' + esc(text == null ? '불러오는 중' : text) + '</span></div>';
    }
  };

  /* ==============================================================
     SHOSession — 로그인 상태
     - 구글 로그인(GIS)은 여기서 한 번만 초기화한다. 버튼은 mountButton(el) 로 그린다.
     - ID 토큰과 이메일·이름은 탭이 살아 있는 동안 sessionStorage 에 둔다. 토큰은 1시간 뒤 만료된다.
     - 설정이 비어 있으면 데모 계정으로 동작한다.
     ============================================================== */
  var Session = (function () {
    var KEY = 'sho.session.' + EVENT_ID;
    var DEMO_USER = { email: 'demo@example.com', name: '데모 참가자', sub: 'demo' };
    var user = null, subs = [], inited = false, initWait = [];

    /**
     * POST 한 번. 평범한 fetch 에 두 가지를 덧댔다.
     *  - 너무 오래 걸리면 끊는다.
     *  - Apps Script 는 일시적으로 막히면 JSON 대신 HTML 안내 페이지를 돌려준다.
     *    BAD_RESPONSE 로 가려내 위쪽에서 다시 보내거나 결과를 확인할 수 있게 한다.
     */
    function send(text, ms) {
      var ctrl = window.AbortController ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 30000) : 0;
      var done = function () { if (timer) clearTimeout(timer); };
      return fetch(C.ENDPOINT, {
        method: 'POST',
        // text/plain 이어야 CORS 사전 요청(preflight) 없이 Apps Script 로 간다
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: text,
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (r) {
        return r.text().then(function (t) {
          done();
          if (!r.ok) throw new Error('HTTP_' + r.status);
          try { return JSON.parse(t); } catch (e) { throw new Error('BAD_RESPONSE'); }
        });
      }, function (err) { done(); throw err; });
    }

    function decodeJWT(t) {
      try {
        var b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(decodeURIComponent(atob(b).split('').map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join('')));
      } catch (e) { return null; }
    }
    function fresh(u) { return !!u && (!u.exp || u.exp * 1000 > Date.now() + 30000); }
    function persist() {
      try { user ? sessionStorage.setItem(KEY, JSON.stringify(user)) : sessionStorage.removeItem(KEY); } catch (e) {}
    }
    function emit() { subs.forEach(function (f) { try { f(user); } catch (e) {} }); }

    try { user = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (!fresh(user) || (DEMO !== !user.token)) { user = null; persist(); }

    function onCredential(res) {
      var p = decodeJWT(res && res.credential);
      if (!p || !p.email) return;
      user = { token: res.credential, email: p.email, name: p.name || p.email, sub: p.sub, pic: p.picture || '', exp: p.exp };
      persist(); emit();
    }

    function waitGIS(cb) {
      var n = 0;
      (function tick() {
        if (window.google && window.google.accounts && window.google.accounts.id) return cb(true);
        if (++n > 60) return cb(false);
        setTimeout(tick, 100);
      })();
    }
    function init(cb) {
      if (inited === true) return cb(true);
      if (inited === 'fail') return cb(false);
      initWait.push(cb);
      if (inited === 'pending') return;
      inited = 'pending';
      waitGIS(function (ok) {
        if (ok) {
          window.google.accounts.id.initialize({
            client_id: C.CLIENT_ID, callback: onCredential, auto_select: false, cancel_on_tap_outside: true
          });
        }
        inited = ok ? true : 'fail';
        var w = initWait; initWait = [];
        w.forEach(function (f) { f(ok); });
      });
    }

    // 만료된 토큰으로 요청하지 않도록, 화면이 다시 활성화될 때 확인한다
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && user && !fresh(user)) { user = null; persist(); emit(); }
    });

    return {
      demo: DEMO,
      get: function () { return fresh(user) ? user : null; },
      onChange: function (f) { subs.push(f); f(this.get()); },

      /**
       * 로그인 버튼을 el 안에 그린다. 데모 모드면 데모 버튼을 그린다.
       * opts: 문자열이면 데모 버튼 문구. 객체면 { label, size, width, compact, icon }
       */
      mountButton: function (el, opts) {
        if (!el) return;
        if (typeof opts === 'string') opts = { label: opts };
        opts = opts || {};
        if (DEMO) {
          el.innerHTML = opts.compact
            ? '<button class="tiny fill" type="button" data-demo="1">' + esc(opts.label || '로그인 (데모)') + '</button>'
            : '<button class="btn btn-o" type="button" data-demo="1"><span>' + esc(opts.label || '미리보기 모드로 열기') + '</span></button>';
          el.querySelector('[data-demo]').addEventListener('click', function () { Session.signIn(); });
          return;
        }
        el.innerHTML = '<div class="ep-gbtn g-wide"></div>' + (opts.icon ? '<div class="ep-gbtn g-icon"></div>' : '');
        var wide = el.querySelector('.g-wide'), icon = el.querySelector('.g-icon');
        init(function (ok) {
          if (!ok) {
            el.innerHTML = opts.compact
              ? '<span class="qhint" style="color:var(--red)">로그인 불러오기 실패</span>'
              : '<p class="qhint" style="color:var(--red)">구글 로그인을 불러오지 못했습니다. 광고 차단 확장을 끄거나 새로고침해 주세요.</p>';
            return;
          }
          window.google.accounts.id.renderButton(wide, {
            theme: 'filled_black', size: opts.size || 'large', text: 'signin_with', shape: 'rectangular', locale: 'ko', width: opts.width || 240
          });
          if (icon) window.google.accounts.id.renderButton(icon, {
            theme: 'filled_black', size: 'medium', type: 'icon', shape: 'circle', locale: 'ko'
          });
        });
      },

      /** 데모 모드 전용 */
      signIn: function () {
        if (!DEMO) return;
        user = { token: '', email: DEMO_USER.email, name: DEMO_USER.name, sub: DEMO_USER.sub, pic: '', exp: 0 };
        persist(); emit();
      },

      signOut: function () {
        try { if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect(); } catch (e) {}
        user = null; persist(); emit();
      },

      /** 쓰기 요청에 붙일 표. 같은 표를 단 요청을 서버가 두 번 처리하지 않는다. */
      nonce: function () {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      },

      /**
       * 서버 호출. 항상 현재 토큰을 실어 보낸다.
       * opts.nonce 쓰기 요청 표 (있으면 다시 보내도 안전) · opts.retry false 면 한 번만 · opts.timeout 밀리초
       */
      api: function (action, extra, opts) {
        var u = this.get();
        var o = opts || {};
        var body = Object.assign({ action: action, idToken: u ? u.token : '' }, extra || {});
        if (o.nonce) body.nonce = o.nonce;
        var text = JSON.stringify(body);
        var tries = o.retry === false ? 1 : 2;
        function attempt(n) {
          return send(text, o.timeout)['catch'](function (err) {
            if (n >= tries) throw err;
            // 잠깐 쉬었다 한 번 더. Apps Script 가 순간적으로 막히는 일이 드물지 않다.
            return new Promise(function (r) { setTimeout(r, 700); }).then(function () { return attempt(n + 1); });
          });
        }
        return attempt(1);
      }
    };
  })();

  /* ============================== 질문 받기 ============================== */
  /** 서버의 GET ?form=1 (데모 모드는 demo-form.js). 실패하면 한 번 더 묻는다. */
  function loadForm() {
    if (DEMO) {
      var demo = window.SHO_DEMO_FORM;
      return demo ? Promise.resolve(JSON.parse(JSON.stringify(demo))) : Promise.reject(new Error('NO_DEMO_FORM'));
    }
    var url = C.ENDPOINT + (C.ENDPOINT.indexOf('?') === -1 ? '?' : '&') + 'form=1';
    function once() {
      var ctrl = window.AbortController ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : 0;
      return fetch(url, { signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (timer) clearTimeout(timer);
          if (!d || !d.ok || !Array.isArray(d.sections)) throw new Error('BAD_FORM');
          return d;
        }, function (e) { if (timer) clearTimeout(timer); throw e; });
    }
    return once()['catch'](function () {
      return new Promise(function (r) { setTimeout(r, 800); }).then(once);
    });
  }

  /* ==============================================================
     모집 기간 문지기
     - 상태는 서버가 판정해 내려 준 값을 쓴다 (서버는 제출마다 다시 검사한다).
     - 로컬(localhost · 127.0.0.1 · file:// · 사설 IP)과 데모 모드에서는 날짜를 보지 않고 열어 둔다.
       닫힌 모습은 주소 끝에 ?gate=closed (모집 전) · ?gate=after (마감 후) · ?gate=real (실제 판정)
       이 덮어쓰기는 로컬·데모에서만 통한다. 배포된 사이트에서는 무시된다.
     ============================================================== */
  function makeGate(g) {
    g = g || {};
    var loc = window.location;
    var host = String(loc.hostname || '').toLowerCase();
    var local =
      loc.protocol === 'file:' ||
      host === '' || host === 'localhost' || host === '127.0.0.1' ||
      host === '::1' || host === '[::1]' || host === '0.0.0.0' ||
      /\.local$/.test(host) ||
      /^192\.168\./.test(host) || /^10\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);

    var state = g.state === 'before' || g.state === 'after' ? g.state : 'open';
    var forced = '';
    if (local || DEMO) {
      var m = /[?&]gate=([a-z]+)/i.exec(loc.search || '');
      forced = m ? m[1].toLowerCase() : '';
      if (forced === 'closed' || forced === 'before') state = 'before';
      else if (forced === 'after') state = 'after';
      else if (forced === 'real') { /* 서버 판정대로 */ }
      else state = 'open';
    }

    var closeAt = g.closeAt ? Date.parse(g.closeAt) : NaN;
    // 마감 전에 열어 둔 탭이 그 뒤에도 신청서를 보이지 않도록, 마감 시각이 지나면 새로 고친다.
    // 이 컴퓨터 시계가 이미 마감을 지났다고 하면(시계가 틀린 경우) 지켜보지 않는다 — 새로 고침이 되풀이된다.
    if (state === 'open' && !DEMO && !isNaN(closeAt) && Date.now() < closeAt && (!local || forced === 'real')) {
      var watch = function () {
        var left = closeAt - Date.now();
        if (left <= 0) { loc.reload(); return; }
        setTimeout(watch, Math.min(left, 60000));
      };
      watch();
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && Date.now() >= closeAt) loc.reload();
      });
    }

    var T = C.GATE_TEXT || {};
    var period = periodOf(g);
    var TEXT = {
      before: {
        tag: 'Opens ' + (mdhm(g.openAt) || period),
        short: md(g.openAt) ? md(g.openAt) + ' 오픈' : '오픈 예정',
        title: (T.before && T.before.title) || '모집 기간에 열립니다',
        why: (T.before && T.before.text) ||
          '아직 모집이 시작되지 않았습니다. 참가 신청은 ' + (mdhm(g.openAt) || period) + '에 열릴 예정이며, 열리면 이 자리에서 바로 신청하실 수 있습니다.'
      },
      after: {
        tag: 'Closed',
        short: '모집 마감',
        title: (T.after && T.after.title) || '모집이 마감되었습니다',
        why: (T.after && T.after.text) || '모집이 끝났습니다. 추가 모집이 열리면 이 자리에 다시 안내하겠습니다.'
      }
    };
    return {
      open: state === 'open', state: state, local: local, forced: forced,
      openAt: g.openAt || '', closeAt: g.closeAt || '', period: period,
      text: TEXT[state] || null
    };
  }

  var LOCK = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.2" aria-hidden="true"><rect x="2.5" y="6" width="9" height="6.5"></rect>' +
    '<path d="M4.6 6V4.2a2.4 2.4 0 0 1 4.8 0V6"></path></svg>';

  /** 모집 기간이 아닐 때: 신청 버튼은 눌리지 않는 안내 라벨로, 신청서 자리에는 안내 패널을 */
  function closeGate(G) {
    var t = G.text;
    qsa('[data-gate="apply"]').forEach(function (a) {
      a.removeAttribute('href');           // href 가 없으면 클릭도 포커스도 가지 않는다
      a.classList.add('gated');
      a.setAttribute('aria-disabled', 'true');
      a.setAttribute('title', t.title + ' (' + G.period + ')');
      var text = esc(a.id === 'nav-apply' ? t.short : t.title);
      // <span> 으로 감싼 버튼은 그 구조를 지켜야 호버 효과 CSS 가 어긋나지 않는다
      a.innerHTML = a.querySelector('span') ? LOCK + '<span>' + text + '</span>' : LOCK + text;
    });

    $('af').hidden = true;
    var box = $('af-gate');
    box.innerHTML = '';
    box.appendChild(h('span', 'lab blue', t.tag));
    box.appendChild(h('b', '', t.title));
    box.appendChild(h('p', '', t.why));
    box.appendChild(h('span', 'when', '모집 ' + G.period));
    var links = (C.HEAD && C.HEAD.links) || [];
    if (links.length) {
      var row = h('div', 'hero-cta row');
      links.forEach(function (l) {
        var a = link(l.href, '', 'btn btn-o');
        a.appendChild(h('span', '', l.label || ''));
        row.appendChild(a);
      });
      box.appendChild(row);
    }
    // 로컬에서 작업할 때만 보이는 안내
    if (G.local || DEMO) {
      var dev = h('div', 'gatedev');
      dev.innerHTML = '<b>미리보기</b> — 지금 <code>?gate=' + esc(G.forced || 'real') + '</code> 로 닫힌 모습을 보고 있습니다. ' +
        '주소에서 <code>?gate=…</code> 를 떼면 미리보기에서는 다시 열립니다.';
      box.appendChild(dev);
    }
    box.hidden = false;
    // 스크롤 등장 효과를 기다리지 않고 바로 보이게 둔다 (안내가 안 보이는 것이 가장 나쁘다)
    box.classList.add('in');
  }

  /** 헤더 오른쪽 로그인 위젯 — 로그인 전엔 구글 버튼, 후엔 사진·이름·로그아웃 */
  function headerAuth() {
    var el = $('top-auth');
    if (!el) return;
    Session.onChange(function (u) {
      if (!u) {
        el.innerHTML = '';
        Session.mountButton(el, { compact: true, size: 'medium', width: 200, icon: true, label: '로그인 (데모)' });
        return;
      }
      el.innerHTML =
        '<div class="who" title="' + esc(u.email) + '">' +
          (u.pic ? '<img src="' + esc(u.pic) + '" alt="" referrerpolicy="no-referrer">' : '') +
          '<span class="nm">' + esc(u.name) + '</span>' +
          '<button class="tiny" type="button" id="top-out">로그아웃</button>' +
        '</div>';
      $('top-out').addEventListener('click', function () { Session.signOut(); });
    });
  }

  /** 카카오톡·인스타그램 등 앱 안 브라우저 → 구글 로그인이 거부되므로 미리 안내 */
  function inAppBand() {
    var ua = navigator.userAgent || '';
    var inapp = /KAKAOTALK|Instagram|FBAN|FBAV|NAVER\(inapp|Line\/|everytimeApp|DaumApps|; wv\)/i.test(ua);
    var bar = $('inapp');
    var KEY = 'sho.inapp.dismissed';
    var dismissed = false;
    try { dismissed = sessionStorage.getItem(KEY) === '1'; } catch (e) {}
    if (!inapp || !bar || dismissed) return;
    bar.hidden = false;
    var open = $('inapp-open');
    var here = location.href;
    if (/KAKAOTALK/i.test(ua)) {
      open.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(here);
    } else if (/Android/i.test(ua)) {
      open.href = 'intent://' + here.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;end';
    } else {
      open.addEventListener('click', function (e) {
        e.preventDefault();
        try { navigator.clipboard.writeText(here); } catch (err) {}
        open.querySelector('span').textContent = '주소 복사됨 · Safari에 붙여넣기';
      });
    }
    $('inapp-x').addEventListener('click', function () {
      bar.hidden = true;
      try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
    });
  }

  /* ============================== 검사 규칙 (서버와 같다) ============================== */
  /** '@octocat', 'https://github.com/octocat/' → 'octocat'. GitHub 아이디가 될 수 없으면 null */
  function githubLogin(value) {
    var s = String(value || '').trim().replace(/^@/, '');
    var url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/?#\s]+)/i);
    if (url) s = url[1];
    s = s.replace(/\/+$/, '');
    return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(s) ? s : null;
  }
  var PHONE = /^[0-9+\-() ]{7,20}$/;
  var REASON = {
    required: '꼭 채워야 하는 항목입니다',
    too_long: '글자 수가 너무 많습니다',
    not_an_option: '보기에 없는 값입니다',
    exclusive_choice: '함께 고를 수 없는 보기를 골랐습니다',
    not_a_phone_number: '전화번호 형식을 확인해 주세요',
    not_a_github_username: 'GitHub 아이디 형식이 아닙니다'
  };

  /* ==============================================================
     신청서 — ENDPoinT 신청서 그대로. 항목은 서버가 준 sections 에서 만든다.
     ============================================================== */
  function startForm(form) {
    var af = $('af');
    var afDone = $('af-done');
    var S = Session;
    var DEV = S.demo;
    var EV = form.event || {};
    var L = C.LEGAL || {};
    var D = C.DONE || {};
    var DRAFT_KEY = 'sho.draft.' + EVENT_ID;

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    var TYPES = {};
    var SCHEMA = form.sections.map(function (s, i) {
      var q = (s.fields || []).map(function (f) {
        TYPES[f.key] = f.type || 'text';
        return {
          k: f.key, t: f.type || 'text', req: !!f.required, ph: f.placeholder || '',
          opts: f.options || [], solo: f.solo || [], chips: (f.chips && f.chips.length) ? f.chips : null,
          full: !!f.full, max: f.max || 0
        };
      });
      var opt = !!s.optional || !q.some(function (x) { return x.req; });
      var sum = s.summary || (opt ? '선택 항목' : q.length > 1 ? q.map(function (x) { return x.k; }).join(' · ') :
        (q[0] && q[0].t === 'multi') ? '중복 선택 가능' : '');
      return { no: pad2(i + 1), name: s.name, hint: s.hint || '', grid: q.length > 1, opt: opt, sum: sum, q: q };
    });

    // 터치가 한 번이라도 발생하면 hover 미리보기를 영구히 끈다 (일부 기기는 hover 를 지원한다고 잘못 보고한다)
    window.addEventListener('touchstart', function mark() {
      document.documentElement.classList.add('touch');
      window.removeEventListener('touchstart', mark);
    }, { passive: true, once: true });

    /* ============================== 유틸 ============================== */
    // 안내문 속 주소는 눌러 열 수 있게 한다 (글자는 모두 이스케이프한 뒤에 링크만 씌운다)
    function hintHTML(t) {
      return '<p class="qhint">' + esc(t).replace(/https?:\/\/[^\s<]+[^\s<.,)]/g, function (u) {
        return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
      }).replace(/\n/g, '<br>') + '</p>';
    }
    function cut(s, n) {
      s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }
    function scrollTo(node, block) {
      if (node && typeof node.scrollIntoView === 'function') {
        try { node.scrollIntoView({ behavior: 'smooth', block: block }); } catch (e) { node.scrollIntoView(); }
      }
    }

    /* ============================= 렌더링 ============================= */
    function optsHTML(q, fi) {
      var type = q.t === 'single' ? 'radio' : 'checkbox';
      var nm = 'f' + fi + '_' + q.k;
      var list = (q.opts || []).map(function (o) {
        return '<label class="opt"><input type="' + type + '" name="' + esc(nm) + '" data-k="' + esc(q.k) +
               '" value="' + esc(o) + '"><span>' + esc(o) + '</span></label>';
      });
      (q.solo || []).forEach(function (o) {
        list.push('<label class="opt no"><input type="' + type + '" name="' + esc(nm) + '" data-k="' + esc(q.k) +
                  '" data-solo="1" value="' + esc(o) + '"><span>' + esc(o) + '</span></label>');
      });
      return '<div class="opts">' + list.join('') + '</div>';
    }

    function chipsHTML(q) {
      return '<div class="opts chipset" data-for="' + esc(q.k) + '">' +
        q.chips.map(function (w) {
          return '<button class="chipin" type="button" data-w="' + esc(w) + '" aria-pressed="false">' +
                 esc(w) + '</button>';
        }).join('') + '</div>';
    }

    function qHTML(q, fi, hideLab) {
      var lab = hideLab ? '' :
        '<span class="lab">' + esc(q.k) + (q.req ? '<span class="req">*</span>' : '') + '</span>';
      var max = q.max ? ' maxlength="' + Number(q.max) + '"' : '';
      var body;

      if (q.t === 'multi' || q.t === 'single') {
        body = optsHTML(q, fi);
      } else if (q.t === 'textarea') {
        body = '<textarea class="tar" data-k="' + esc(q.k) + '"' + max + ' placeholder="' + esc(q.ph) + '"></textarea>';
      } else if (q.t === 'github') {
        // 아이디만 적어도, @아이디·프로필 주소를 붙여 넣어도 된다. 아래 줄에서 본인 계정인지 눌러 확인한다.
        body = '<input class="tin" type="text" data-k="' + esc(q.k) + '"' + max +
               ' autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url"' +
               ' placeholder="' + esc(q.ph) + '">' +
               '<p class="qhint gh-check" data-gh="' + esc(q.k) + '" aria-live="polite"></p>';
      } else {
        body = (q.chips ? chipsHTML(q) : '') +
               '<input class="tin" type="' + (q.t === 'tel' ? 'tel' : 'text') + '" data-k="' + esc(q.k) + '"' + max +
               (q.t === 'tel' ? ' inputmode="tel" autocomplete="tel"' : '') +
               ' placeholder="' + esc(q.ph) + '">';
      }
      return '<div class="q' + (q.full ? ' full' : '') + '">' + lab + body + '</div>';
    }

    function fieldHTML(f, fi) {
      var inner = '';
      if (f.hint) inner += hintHTML(f.hint);
      // 항목에 질문이 하나뿐이면 헤더가 이미 이름을 말하므로 하위 라벨은 생략
      var qs = f.q.map(function (q) { return qHTML(q, fi, f.q.length === 1); }).join('');
      inner += f.grid ? '<div class="qgrid">' + qs + '</div>' : qs;

      return '<div class="fld" data-i="' + fi + '">' +
               '<button class="fld-hd" type="button" aria-expanded="false" aria-controls="fb' + fi + '">' +
                 '<span class="fld-no">' + esc(f.no) + '</span>' +
                 '<span class="fld-name">' + esc(f.name) + (f.opt ? '' : '<span class="req">*</span>') + '</span>' +
                 '<span class="fld-val"></span>' +
                 '<span class="fld-mark"></span>' +
               '</button>' +
               '<div class="fld-bd" id="fb' + fi + '"><div class="fld-in"><div class="fld-pad">' +
                 inner +
               '</div></div></div>' +
             '</div>';
    }

    function legalHTML() {
      var t = safeHref(L.terms), p = safeHref(L.privacy);
      if (t || p) {
        return '제출하면 ' + (t ? '<a href="' + esc(t) + '">이용약관</a>에 동의하고 ' : '') +
               (p ? '<a href="' + esc(p) + '">개인정보처리방침</a>을 확인한 것으로 봅니다.' : '동의한 것으로 봅니다.');
      }
      var u = safeHref(EV.privacyUrl);
      return esc(EV.privacy || '') + (u ? ' <a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">자세히</a>' : '');
    }
    var privacyLink = safeHref(L.privacy) || safeHref(EV.privacyUrl);

    af.innerHTML =
      '<div class="af-gate">' +
        '<div class="t"><b>구글 계정으로 시작하기</b>' +
        '<span>' + esc(EV.intro || '신청자 확인과 중복 제출 방지를 위해 로그인이 필요합니다.') +
        (privacyLink ? ' 구글 계정 정보 이용은 <a href="' + esc(privacyLink) + '">개인정보처리방침</a>을 참고해 주세요.' : '') +
        '</span></div>' +
        '<div id="af-auth"></div>' +
      '</div>' +
      '<div class="af-state" id="af-state" hidden></div>' +
      '<div class="af-prog"><span class="n" id="af-n">0 / ' + SCHEMA.length + '</span>' +
      '<span class="t"><span class="f" id="af-f"></span></span></div>' +
      SCHEMA.map(fieldHTML).join('') +
      '<div class="af-send" id="af-send">' +
        '<div class="t"><p id="af-tip">먼저 <b>구글 로그인</b>을 해주세요.</p>' +
        '<p class="af-legal">' + legalHTML() + '</p></div>' +
        '<div class="af-acts">' +
          '<button class="btn btn-o" type="button" id="af-cancel" hidden><span>취소</span></button>' +
          '<button class="btn btn-o" type="button" id="af-edit" hidden><span>수정하기</span></button>' +
          '<button class="btn" type="button" id="af-go" disabled><span>신청서 제출</span></button>' +
        '</div>' +
      '</div>' +
      '<p class="af-msg" id="af-msg"></p>';

    var flds = qsa('.fld', af);
    var elN = $('af-n');
    var elF = $('af-f');
    var elGo = $('af-go');
    var elTip = $('af-tip');
    var elMsg = $('af-msg');
    var elSend = $('af-send');
    var elAuth = $('af-auth');
    var elState = $('af-state');
    var elEdit = $('af-edit');
    var elCancel = $('af-cancel');

    /* ========================== 값 읽기 · 검증 ========================== */
    /** 서버가 저장할 모양 그대로 읽는다 (공백 정리, GitHub 아이디는 아이디만) */
    function clean(s, t) {
      s = String(s || '');
      if (t === 'textarea') return s.replace(/\r\n/g, '\n').trim();
      s = s.replace(/\s+/g, ' ').trim();
      if (t === 'github') return githubLogin(s) || s;
      return s;
    }
    function read() {
      var v = {};
      qsa('[data-k]', af).forEach(function (n) {
        var k = n.getAttribute('data-k');
        if (n.type === 'checkbox') { if (n.checked) (v[k] = v[k] || []).push(n.value); }
        else if (n.type === 'radio') { if (n.checked) v[k] = n.value; }
        else { var s = clean(n.value, TYPES[k]); if (s) v[k] = s; }
      });
      return v;
    }

    /** 채운 값이 서버 검사를 통과하지 못할 까닭. 문제없으면 '' */
    function problem(q, x) {
      if (x == null || x === '' || (Array.isArray(x) && !x.length)) return q.req ? REASON.required : '';
      if (q.max && String(x).length > q.max) return REASON.too_long + ' (최대 ' + q.max + '자)';
      if (q.t === 'tel' && !PHONE.test(x)) return REASON.not_a_phone_number;
      if (q.t === 'github' && !githubLogin(x)) return REASON.not_a_github_username;
      return '';
    }
    function isDone(f, v) {
      return f.q.every(function (q) { return !problem(q, v[q.k]); });
    }
    function firstProblem(f, v) {
      for (var j = 0; j < f.q.length; j++) {
        var p = problem(f.q[j], v[f.q[j].k]);
        if (p) return { q: f.q[j], text: p };
      }
      return null;
    }

    function summarize(f, v) {
      var parts = [];
      f.q.forEach(function (q) {
        var x = v[q.k];
        if (!x || (Array.isArray(x) && !x.length)) return;
        parts.push(Array.isArray(x) ? x.join(', ') : x);
      });
      return cut(parts.join(' · '), 64);
    }

    /** GitHub 칸 아래 줄: 아이디가 맞으면 프로필 링크, 형식이 틀리면 까닭 */
    function githubCheck(v) {
      qsa('[data-gh]', af).forEach(function (p) {
        var k = p.getAttribute('data-gh');
        var input = af.querySelector('[data-k="' + k.replace(/"/g, '\\"') + '"]');
        var raw = input ? input.value.trim() : '';
        var login = githubLogin(raw);
        p.textContent = '';
        p.classList.remove('bad');
        if (input) input.removeAttribute('aria-invalid');
        if (!raw) return;
        if (!login) {
          p.classList.add('bad');
          p.textContent = REASON.not_a_github_username + ' — 영문·숫자·하이픈(-)만, 39자까지입니다.';
          if (input) input.setAttribute('aria-invalid', 'true');
          return;
        }
        p.appendChild(document.createTextNode('본인 계정이 맞는지 눌러 확인해 주세요: '));
        p.appendChild(link('https://github.com/' + encodeURIComponent(login), 'github.com/' + login));
      });
      // 전화번호처럼 형식이 정해진 칸은 틀리면 밑줄을 빨갛게
      qsa('input[type="tel"][data-k]', af).forEach(function (n) {
        var s = clean(n.value, 'tel');
        if (s && !PHONE.test(s)) n.setAttribute('aria-invalid', 'true'); else n.removeAttribute('aria-invalid');
      });
      return v;
    }

    /* ============================ 상태 갱신 ============================ */
    var submitted = false;
    var mode = 'new';   // new(새로 작성) | view(낸 신청서 보기) | edit(수정 중) | loading
    var mine = null;    // 시트에서 불러온 기존 신청 내용

    function refresh() {
      var v = read();
      var done = 0;

      // 자유 입력란 빠른 선택 칩의 선택 상태 동기화
      qsa('.chipset', af).forEach(function (set) {
        var input = af.querySelector('[data-k="' + set.getAttribute('data-for').replace(/"/g, '\\"') + '"]');
        var parts = ((input && input.value) || '').split(',').map(function (x) { return x.trim(); });
        qsa('.chipin', set).forEach(function (c) {
          c.setAttribute('aria-pressed', String(parts.indexOf(c.getAttribute('data-w')) !== -1));
        });
      });
      githubCheck(v);

      SCHEMA.forEach(function (f, i) {
        var ok = isDone(f, v);
        var node = flds[i];
        if (ok) done++;
        node.classList.toggle('done', ok);
        node.classList.remove('bad');
        node.querySelector('.fld-val').textContent = summarize(f, v) || f.sum || '';
      });

      elN.textContent = done + ' / ' + SCHEMA.length;
      elF.style.width = Math.round(done / SCHEMA.length * 100) + '%';

      var ready = auth.on && done === SCHEMA.length;
      elGo.disabled = !ready || submitted || mode === 'view' || mode === 'loading';
      elSend.classList.toggle('ready', ready && !submitted && mode !== 'view');

      if (!auth.on) elTip.innerHTML = '먼저 <b>구글 로그인</b>을 해주세요.';
      else if (mode === 'loading') elTip.innerHTML = UI.loading('신청 내역을 확인하는 중');
      else if (mode === 'view') elTip.innerHTML = '<b>' + esc(auth.email) + '</b> 계정으로 접수된 신청서입니다.';
      else if (!ready) elTip.innerHTML = '<b>*</b> 표시된 항목을 모두 채우면 ' + (mode === 'edit' ? '저장' : '제출') + '할 수 있습니다.';
      else if (mode === 'edit') elTip.innerHTML = '저장하면 <b>' + esc(auth.email) + '</b> 계정의 기존 신청서를 덮어씁니다.';
      else elTip.innerHTML = '<b>' + esc(auth.email) + '</b> 계정으로 제출됩니다. 제출 후에도 다시 로그인하면 수정할 수 있습니다.';

      saveDraft(v);
      return v;
    }

    /* =========================== 펼침 / 고정 =========================== */
    function pin(node, on) {
      node.classList.toggle('pin', on);
      node.querySelector('.fld-hd').setAttribute('aria-expanded', String(!!on));
    }

    flds.forEach(function (node) {
      var hd = node.querySelector('.fld-hd');
      hd.addEventListener('click', function () {
        if (af.classList.contains('locked')) return;
        var was = node.classList.contains('pin');
        pin(node, !was);
        // 고정을 풀 때, 본문 안에 남아 있는 포커스까지 걷어내야 실제로 닫힌다
        if (was) {
          var a = document.activeElement;
          if (a && a !== hd && node.contains(a) && typeof a.blur === 'function') a.blur();
        }
      });
      // 본문을 건드리면 고정 — 마우스가 벗어나도 닫히지 않게
      node.querySelector('.fld-bd').addEventListener('mousedown', function () { pin(node, true); });
      node.addEventListener('focusin', function (e) {
        if (e.target === hd) return;
        pin(node, true);
      });
    });

    /* =========================== 입력 이벤트 =========================== */
    af.addEventListener('change', function (e) {
      var n = e.target;
      // '모든 일정 참석 가능' 같은 배타 선택지 처리
      if (n.type === 'checkbox' && n.getAttribute('data-k')) {
        var same = qsa('input[data-k]', af).filter(function (o) { return o.getAttribute('data-k') === n.getAttribute('data-k'); });
        if (n.hasAttribute('data-solo') && n.checked) {
          same.forEach(function (o) { if (o !== n) o.checked = false; });
        } else if (n.checked) {
          same.forEach(function (o) { if (o.hasAttribute('data-solo')) o.checked = false; });
        }
      }
      // GitHub 칸은 칸을 떠날 때 '@아이디'·주소를 아이디만 남겨 보여 준다
      if (n.getAttribute && TYPES[n.getAttribute('data-k')] === 'github') {
        var login = githubLogin(n.value);
        if (login) n.value = login;
      }
      refresh();
    });
    af.addEventListener('input', function () { refresh(); });

    // 자유 입력란 빠른 선택 칩
    af.addEventListener('click', function (e) {
      var c = e.target && e.target.closest ? e.target.closest('.chipin') : null;
      if (!c) return;
      var key = c.parentNode.getAttribute('data-for');
      var input = qsa('[data-k]', af).filter(function (n) { return n.getAttribute('data-k') === key; })[0];
      if (!input) return;
      var w = c.getAttribute('data-w');
      var parts = (input.value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      var i = parts.indexOf(w);
      if (i === -1) parts.push(w); else parts.splice(i, 1);
      input.value = parts.join(', ');
      refresh();
    });

    /* ======================= 폼 비우기 · 채우기 ======================= */
    function clearForm() {
      qsa('[data-k]', af).forEach(function (n) {
        if (n.type === 'checkbox' || n.type === 'radio') n.checked = false;
        else n.value = '';
      });
      flds.forEach(function (n) { n.classList.remove('done', 'bad'); pin(n, false); });
    }

    // 시트에서 온 값은 여러 개 고른 항목이 '가, 나' 처럼 한 칸에 합쳐져 있을 수 있으므로 되돌린다
    function fillForm(v) {
      clearForm();
      qsa('[data-k]', af).forEach(function (n) {
        var x = v[n.getAttribute('data-k')];
        if (x === null || x === undefined || x === '') return;
        if (n.type === 'checkbox' || n.type === 'radio') {
          var list = Array.isArray(x) ? x : String(x).split(',').map(function (t) { return t.trim(); });
          n.checked = list.indexOf(n.value) !== -1;
        } else {
          n.value = Array.isArray(x) ? x.join(', ') : String(x);
        }
      });
    }

    /* ============================ 임시 저장 ============================ */
    // 누구의 임시 저장본인지 같이 적어둔다. 계정이 바뀌면 쓰지 않는다.
    var saveT = 0;
    function saveDraft(v) {
      if (!auth.on || (mode !== 'new' && mode !== 'edit')) return;
      clearTimeout(saveT);
      saveT = setTimeout(function () {
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ owner: auth.email, v: v })); } catch (e) {}
      }, 400);
    }
    function dropDraft() {
      clearTimeout(saveT);
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    }
    function hasDraft() {
      var d = null;
      try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) {}
      return !!(d && d.v && d.owner && d.owner === auth.email);
    }
    function loadDraft() {
      var d = null;
      try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) {}
      // 형식이 옛날이거나 다른 계정 것이면 버린다
      if (!d || !d.v || !d.owner || d.owner !== auth.email) { dropDraft(); return false; }
      fillForm(d.v);
      return true;
    }

    /* ============================= 모드 전환 ============================= */
    function setReadonly(on) {
      qsa('input, select, textarea, .chipin', af).forEach(function (n) { n.disabled = on; });
    }

    function when(iso) {
      if (!iso) return '';
      var d = new Date(iso);
      if (isNaN(d)) return String(iso);
      return d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()) +
             ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    /** 제출 버튼을 대기 상태로 바꾼다. 켜지면 버튼 안에서 로딩 표시가 돈다. */
    function goBusy(on, text) {
      elGo.disabled = !!on;
      elGo.innerHTML = (on ? UI.spin('sm ink') : '') + '<span>' + esc(text) + '</span>';
    }
    function setMode(m) {
      mode = m;
      af.classList.toggle('ro', m === 'view');
      setReadonly(m === 'view' || m === 'loading');

      elEdit.hidden = m !== 'view';
      elCancel.hidden = m !== 'edit';
      elGo.hidden = m === 'view' || m === 'loading';
      goBusy(false, m === 'edit' ? '수정 내용 저장' : '신청서 제출');

      if (m === 'view' || m === 'edit') {
        elState.hidden = false;
        elState.classList.toggle('edit', m === 'edit');
        var at = mine && mine.answers ? when(mine.answers['제출시각']) : '';
        elState.innerHTML = m === 'view'
          ? '<span class="lab">신청 완료</span><b>' + (at ? esc(at) + ' 에 접수되었습니다.' : '이미 신청하셨습니다.') + '</b>' +
            '<i>내용을 바꾸려면 오른쪽 수정하기를 누르세요.</i>'
          : '<span class="lab">수정 중</span><b>저장을 꼭 눌러주세요.</b>';
      } else {
        elState.hidden = true;
      }
      refresh();
    }

    /* ====================== 기존 신청 내역 불러오기 ====================== */
    /** 로그인하면 이 계정이 이미 냈는지 서버에 묻는다 (action: me) */
    function lookUp() {
      setMode('loading');
      S.api('me')
        .then(useMine)
        ['catch'](function () {
          if (!auth.on) return;
          loadDraft();
          setMode('new');
          msg('기존 신청 내역을 불러오지 못했습니다. 그대로 제출하면 기존 신청서가 갱신되므로 중복 접수되지는 않습니다.', 'err');
        });
    }

    function useMine(d) {
      if (!auth.on) return;                 // 그 사이 로그아웃했으면 그만둔다
      if (d && d.ok && d.found) {
        mine = d;
        fillForm(d.answers);
        if (hasDraft()) {         // 토큰 만료 등으로 저장 못 한 수정본이 있으면 이어서 고치게 한다
          loadDraft();
          setMode('edit');
          msg('저장하지 못한 수정 내용을 복원했습니다. 확인 후 저장을 눌러 주세요.', 'ok');
        } else {
          dropDraft();            // 시트 내용이 기준이므로 임시 저장본은 버린다
          setMode('view');
        }
        return;
      }
      if (d && d.error === 'AUTH_FAILED') { signOutExpired(); return; }
      loadDraft();
      setMode('new');
    }

    elEdit.addEventListener('click', function () {
      elMsg.className = 'af-msg';
      setMode('edit');
      scrollTo(flds[0], 'start');
    });

    elCancel.addEventListener('click', function () {
      if (mine && mine.answers) fillForm(mine.answers);
      dropDraft();
      elMsg.className = 'af-msg';
      setMode('view');
    });

    /* =========================== 구글 로그인 =========================== */
    var auth = { on: false, token: '', email: '', name: '', pic: '' };

    function setAuth(u) {
      auth = { on: true, token: u.token, email: u.email, name: u.name || u.email, pic: u.pic || '' };
      elAuth.innerHTML =
        '<div class="af-who">' +
          (auth.pic ? '<img src="' + esc(auth.pic) + '" alt="" referrerpolicy="no-referrer">' : '') +
          '<div class="m"><b>' + esc(auth.name) + '</b><span>' + esc(auth.email) + '</span>' +
          '<button class="af-out" type="button" id="af-out">다른 계정으로</button></div>' +
        '</div>';
      $('af-out').addEventListener('click', signOut);
      af.classList.remove('locked');

      // 계정이 바뀌었을 수 있으니 항상 비우고 시작한다
      mine = null;
      clearForm();

      if (DEV) { loadDraft(); setMode('new'); return; }
      lookUp();
    }

    // 화면을 로그인 전 상태로 되돌린다. 다음 사람에게 앞사람 입력이 남지 않도록 임시 저장본도 지운다.
    // 단, 토큰 만료로 밀려난 경우는 임시 저장본을 남겨 두어 같은 계정으로 다시 로그인하면 복원된다.
    var expiredNote = '';
    function resetAuthUI() {
      auth = { on: false, token: '', email: '', name: '', pic: '' };
      mine = null;
      submitted = false;
      if (!expiredNote) dropDraft(); else clearTimeout(saveT);
      clearForm();
      afDone.classList.remove('on');
      af.style.display = '';
      elMsg.className = 'af-msg';
      af.classList.add('locked');
      mountLogin();
      setMode('new');
      if (expiredNote) { msg(expiredNote, 'err'); expiredNote = ''; }
    }

    function signOut() { S.signOut(); }
    function signOutExpired() {
      expiredNote = '로그인이 만료되었습니다. 같은 계정으로 다시 로그인하면 작성 중이던 내용이 복원됩니다.';
      S.signOut();
    }

    function mountLogin() {
      elAuth.innerHTML = '';
      S.mountButton(elAuth, '미리보기 모드로 열기');
    }

    /* ============================== 제출 ============================== */
    function msg(text, kind) {
      elMsg.textContent = text;
      elMsg.className = 'af-msg on ' + (kind || '');
    }

    function firstIncomplete(v) {
      for (var i = 0; i < SCHEMA.length; i++) if (!isDone(SCHEMA[i], v)) return i;
      return -1;
    }
    function sectionOf(key) {
      for (var i = 0; i < SCHEMA.length; i++) {
        for (var j = 0; j < SCHEMA[i].q.length; j++) if (SCHEMA[i].q[j].k === key) return i;
      }
      return -1;
    }
    function markBad(i, text) {
      flds[i].classList.add('bad');
      pin(flds[i], true);
      scrollTo(flds[i], 'center');
      msg(SCHEMA[i].no + ' ' + SCHEMA[i].name + ' — ' + text, 'err');
    }

    elGo.addEventListener('click', function () {
      var v = refresh();

      var bad = firstIncomplete(v);
      if (bad !== -1) {
        var p = firstProblem(SCHEMA[bad], v);
        markBad(bad, p && p.text !== REASON.required ? (SCHEMA[bad].q.length > 1 ? p.q.k + ': ' : '') + p.text : '항목을 채워주세요.');
        return;
      }

      var editing = mode === 'edit';
      goBusy(true, editing ? '저장 중' : '제출 중');
      msg(editing ? '수정 내용을 저장하는 중입니다...' : '신청서를 보내는 중입니다...', '');

      if (DEV) {
        if (window.console) console.log('[미리보기 모드] 실제 전송 없이 아래 내용이 시트로 갑니다:', v);
        setTimeout(function () { finish(v, true); }, 700);
        return;
      }

      // nonce 를 달아 두면 같은 제출이 두 번 처리되지 않는다.
      // 그래서 응답이 끊겼을 때 안심하고 다시 보낼 수 있다 (S.api 가 알아서 한 번 더 보낸다).
      S.api('submit', { answers: v }, { nonce: S.nonce() })
        .then(function (d) {
          if (d && d.ok) { succeed(); return; }
          var err = (d && d.error) || '';
          if (err === 'AUTH_FAILED') { signOutExpired(); return; }
          if (err === 'INVALID' && d.fields && d.fields.length) {
            var f = d.fields[0], i = sectionOf(f.key);
            goBusy(false, editing ? '다시 저장' : '다시 제출');
            if (i > -1) { markBad(i, (SCHEMA[i].q.length > 1 ? f.key + ': ' : '') + (REASON[f.reason] || f.reason)); return; }
          }
          if (err === 'NOT_OPEN_YET' || err === 'CLOSED') {
            fail(err === 'CLOSED' ? '모집이 마감되어 접수되지 않았습니다.' : '아직 모집 기간이 아니라 접수되지 않았습니다.');
            return;
          }
          fail('제출에 실패했습니다. (' + (err || '알 수 없는 오류') + ')');
        })
        ['catch'](function () {
          // 두 번 보내고도 응답을 못 받았다. 그래도 시트에는 들어갔을 수 있으므로
          // (Apps Script 는 일을 끝내고 응답만 흘려보내는 일이 있다) 직접 확인한다.
          var lost = '네트워크 오류로 제출하지 못했습니다. 잠시 후 다시 눌러주세요.';
          msg('응답이 늦어 접수 여부를 확인하는 중입니다...', '');
          S.api('me', null, { retry: false })
            .then(function (d) {
              if (d && d.ok && d.found && landed(d.answers)) { succeed(); return; }
              fail(lost);
            })
            ['catch'](function () { fail(lost); });
        });

      /**
       * 시트에 있는 내용이 방금 보낸 것과 같은가. 수정 제출이면 행은 원래부터 있었으니
       * "행이 있다"만으로는 모자라 값을 맞춰 본다. 서버가 값을 다듬는 방식(배열은 쉼표로 잇고,
       * 앞의 '=' 는 걷어낸다)에 맞춰 양쪽을 같은 모양으로 만든 뒤 비교한다.
       */
      function landed(answers) {
        if (!answers) return false;
        var norm = function (x) {
          return [].concat(x == null ? '' : x).join(', ').replace(/^[=\s]+/, '').trim();
        };
        for (var i = 0; i < SCHEMA.length; i++) {
          for (var j = 0; j < SCHEMA[i].q.length; j++) {
            var k = SCHEMA[i].q[j].k;
            if (norm(answers[k]) !== norm(v[k])) return false;
          }
        }
        return true;
      }

      function succeed() {
        if (editing) {
          // 수정은 완료 화면까지 갈 필요 없이 제자리에서 마무리한다
          v['제출시각'] = new Date().toISOString();
          v['이메일'] = auth.email;
          mine = { found: true, answers: v };
          dropDraft();
          setMode('view');
          msg('수정 내용을 저장했습니다.', 'ok');
          scrollTo(elState, 'center');
          return;
        }
        finish(v, false);
      }
    });

    function fail(text) {
      msg(text, 'err');
      goBusy(false, mode === 'edit' ? '다시 저장' : '다시 제출');
    }

    /** 완료 화면 요약에 보일 질문. 설정이 없으면 앞에서부터 고른다 (전화번호는 화면에 다시 띄우지 않는다) */
    function recapKeys() {
      if (D.recap && D.recap.length) return D.recap;
      var out = [];
      SCHEMA.forEach(function (f) {
        f.q.forEach(function (q) { if (q.t !== 'tel' && out.length < 7) out.push(q.k); });
      });
      return out;
    }

    function finish(v, preview) {
      submitted = true;
      // 공용 PC 에 이름·연락처가 남지 않도록 임시 저장본을 지운다
      if (!preview) dropDraft();
      elMsg.className = 'af-msg';
      // 완료 화면으로 넘어가기 전에 제출 버튼의 로딩 표시를 걷어낸다
      goBusy(false, '신청서 제출');
      af.style.display = 'none';

      var rows = [['계정', auth.email]].concat(recapKeys().map(function (k) {
        return [k, cut([].concat(v[k] == null ? [] : v[k]).join(', '), 40) || '-'];
      }));

      afDone.innerHTML =
        '<span class="lab blue">' + (preview ? 'Preview' : 'Submitted') + '</span>' +
        '<h3>' + (preview ? '미리보기 제출 완료' : esc(D.title || '신청이 접수되었습니다')) + '</h3>' +
        '<p id="af-done-text"></p>' +
        '<div class="af-recap">' + rows.map(function (r) {
          return '<div><span class="lab">' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>';
        }).join('') + '</div>' +
        '<div class="hero-cta" id="af-done-acts" style="margin-top:20px">' +
          '<button class="btn btn-o" type="button" id="af-again"><span>신청서 다시 열기</span></button>' +
        '</div>';
      rich($('af-done-text'), preview
        ? '설정(config.js)이 비어 있어 실제 시트에는 기록되지 않았습니다. 개발자 도구 콘솔에서 전송될 내용을 확인할 수 있습니다.'
        : (D.text || '신청해주셔서 감사합니다.'), true);
      var acts = $('af-done-acts');
      (D.links || []).forEach(function (l) {
        var a = link(l.href, '', 'btn');
        a.appendChild(h('span', '', l.label || ''));
        acts.insertBefore(a, acts.firstChild);
      });
      afDone.classList.add('on');
      scrollTo(afDone, 'center');

      $('af-again').addEventListener('click', function () {
        submitted = false;
        afDone.classList.remove('on');
        af.style.display = '';
        if (!preview) {
          v['제출시각'] = v['제출시각'] || new Date().toISOString();
          mine = { found: true, answers: v };
          setMode('view');
        } else {
          setMode('new');
        }
        scrollTo(af, 'start');
      });
    }

    S.onChange(function (u) {
      if (u) { if (!auth.on || auth.email !== u.email) setAuth(u); }
      else resetAuthUI();
    });

    /* ============================== 시작 ============================== */
    refresh();
  }

  /* ============================== 시작 ============================== */
  var ready;
  function boot() {
    renderPage();
    initMotion();
    var af = $('af');
    af.innerHTML = '<div class="af-gate">' + UI.loading('신청서를 불러오는 중') + '</div>';
    ready = loadForm().then(function (form) {
      var G = makeGate(form.gate);
      setVars({ period: G.period, open: mdhm(G.openAt) || G.period, close: mdhm(G.closeAt) || G.period });
      if (!G.open) { closeGate(G); return G; }
      headerAuth();
      startForm(form);
      inAppBand();
      return G;
    }, function () {
      af.innerHTML = '';
      var box = h('div', 'af-gate');
      var t = h('div', 't');
      t.appendChild(h('b', '', '신청서를 불러오지 못했습니다'));
      t.appendChild(h('span', '', '잠시 후 다시 시도해 주세요. 계속 안 되면 운영진에게 알려 주세요.'));
      var again = h('button', 'btn btn-o');
      again.type = 'button';
      again.appendChild(h('span', '', '다시 불러오기'));
      again.addEventListener('click', function () { location.reload(); });
      box.appendChild(t);
      box.appendChild(again);
      af.appendChild(box);
      af.classList.add('in');
      return null;
    });
  }

  window.SHO = {
    githubLogin: githubLogin,
    safeHref: safeHref,
    session: Session,
    ready: function () { return ready; }
  };
  boot();
})();
