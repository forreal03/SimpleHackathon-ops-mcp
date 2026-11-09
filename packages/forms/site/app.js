/*
 * SimpleHackathon forms — application page.
 * Adapted from the ENDPoinT 2026 site. The questions come from the Apps Script backend (Config.gs),
 * so this file is the same for every event. Only config.js changes.
 *
 * Without CLIENT_ID/ENDPOINT it runs in demo mode with the default questions and no network.
 * Everything is built with DOM APIs; nothing from the server or the user is parsed as HTML.
 */
(function () {
  'use strict';

  var CFG = window.SHO_CONFIG || {};
  var DEMO = !CFG.CLIENT_ID || !CFG.ENDPOINT;
  var SESSION_KEY = 'sho.session.v1';
  var root = document.getElementById('app');
  var S = { form: null, user: null, answers: {}, found: false, busy: false, errors: {} };

  var MESSAGES = {
    required: '필수 항목입니다.',
    not_an_option: '보기에서 골라주세요.',
    exclusive_choice: '이 선택지는 다른 항목과 함께 고를 수 없습니다.',
    too_long: '너무 깁니다.',
    not_a_phone_number: '전화번호 형식이 아닙니다.',
    not_a_github_username: 'GitHub 아이디 형식이 아닙니다 (영문·숫자·하이픈, 39자 이내).'
  };

  /* ------------------------------------------------------------- DOM */

  function h(tag, props, children) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  /** Multi-line text as lines, without HTML. */
  function lines(text, cls) {
    var p = h('p', { class: cls });
    String(text || '').split('\n').forEach(function (line, i) {
      if (i) p.appendChild(document.createElement('br'));
      p.appendChild(document.createTextNode(line));
    });
    return p;
  }

  function setStatus(kind, text) {
    var box = document.getElementById('status');
    if (!box) return;
    box.className = 'status ' + (kind || '');
    box.textContent = text || '';
  }

  /* --------------------------------------------------------- network */

  function getForm() {
    if (DEMO) return Promise.resolve(window.SHO_DEMO_FORM);
    return fetch(CFG.ENDPOINT + '?form=1').then(function (r) {
      if (!r.ok) throw new Error('HTTP_' + r.status);
      return r.json();
    });
  }

  /** One POST. Apps Script sometimes answers with an HTML page; that is BAD_RESPONSE, not "failed". */
  function post(body, ms) {
    if (DEMO) return demoPost(body);
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 30000) : 0;
    return fetch(CFG.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP_' + r.status);
        try { return JSON.parse(t); } catch (e) { throw new Error('BAD_RESPONSE'); }
      });
    }, function (err) { if (timer) clearTimeout(timer); throw err; });
  }

  function demoPost(body) {
    var key = 'sho.demo.answers';
    if (body.action === 'me') {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
      return Promise.resolve(saved ? { ok: true, found: true, answers: saved } : { ok: true, found: false });
    }
    var errors = validate(body.answers).errors;
    if (errors.length) return Promise.resolve({ ok: false, error: 'INVALID', fields: errors });
    try { localStorage.setItem(key, JSON.stringify(body.answers)); } catch (e) {}
    return Promise.resolve({ ok: true, updated: S.found });
  }

  /* --------------------------------------------------------- session */

  function decodeJWT(t) {
    try {
      var b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(atob(b).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join('')));
    } catch (e) { return null; }
  }

  function fresh(u) { return !!u && (!u.exp || u.exp * 1000 > Date.now() + 30000); }

  function saveSession() {
    try { S.user ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(S.user)) : sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function onCredential(res) {
    var p = decodeJWT(res && res.credential);
    if (!p || !p.email) return;
    S.user = { token: res.credential, email: p.email, name: p.name || p.email, exp: p.exp };
    saveSession();
    loadMine();
  }

  function mountGoogleButton(el) {
    var tries = 0;
    (function wait() {
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.initialize({ client_id: CFG.CLIENT_ID, callback: onCredential, auto_select: false, cancel_on_tap_outside: true });
        google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
        return;
      }
      if (++tries > 80) { el.textContent = '구글 로그인을 불러오지 못했습니다. 새로 고쳐 주세요.'; return; }
      setTimeout(wait, 100);
    })();
  }

  function logout() {
    S.user = null; S.answers = {}; S.found = false; S.errors = {};
    saveSession();
    try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) {}
    render();
  }

  /* ------------------------------------------------------ validation */

  function fields() {
    var out = [];
    (S.form && S.form.sections || []).forEach(function (s) { (s.fields || []).forEach(function (f) { out.push(f); }); });
    return out;
  }

  function githubLogin(value) {
    var s = String(value || '').trim().replace(/^@/, '');
    var url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/?#\s]+)/i);
    if (url) s = url[1];
    s = s.replace(/\/+$/, '');
    return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(s) ? s : null;
  }

  /** Same rules as the server (Code.gs validate_), so most mistakes show before sending. */
  function validate(answers) {
    var errors = [];
    fields().forEach(function (f) {
      var raw = answers[f.key];
      var bad = function (reason) { errors.push({ key: f.key, reason: reason }); };
      if (f.type === 'multi') {
        var list = Array.isArray(raw) ? raw : [];
        var solo = list.filter(function (x) { return (f.solo || []).indexOf(x) > -1; });
        if (solo.length && list.length > 1) return bad('exclusive_choice');
        if (f.required && !list.length) bad('required');
        return;
      }
      var text = String(raw == null ? '' : raw).trim();
      if (!text) { if (f.required) bad('required'); return; }
      if (text.length > f.max) return bad('too_long');
      if (f.type === 'single' && f.options.indexOf(text) === -1) return bad('not_an_option');
      if (f.type === 'tel' && !/^[0-9+\-() ]{7,20}$/.test(text)) return bad('not_a_phone_number');
      if (f.type === 'github' && !githubLogin(text)) bad('not_a_github_username');
    });
    return { errors: errors };
  }

  /* ----------------------------------------------------------- draft */

  function draftKey() { return 'sho.draft.' + (S.form ? S.form.event.title : '') + '.' + (S.user ? S.user.email : ''); }
  function saveDraft() { try { localStorage.setItem(draftKey(), JSON.stringify(S.answers)); } catch (e) {} }
  function loadDraft() { try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch (e) { return null; } }
  function clearDraft() { try { localStorage.removeItem(draftKey()); } catch (e) {} }

  /* ----------------------------------------------------------- fields */

  function fieldId(f) { return 'f-' + fields().indexOf(f); }

  function errorNode(f) {
    var reason = S.errors[f.key];
    return reason ? h('p', { class: 'error', id: fieldId(f) + '-err', role: 'alert', text: MESSAGES[reason] || reason }) : null;
  }

  /** Stores a value and clears that field's error in place (no re-render, so typing keeps focus). */
  function update(f, value) {
    S.answers[f.key] = value;
    if (S.errors[f.key]) {
      delete S.errors[f.key];
      var err = document.getElementById(fieldId(f) + '-err');
      if (err) err.parentNode.removeChild(err);
      var input = document.getElementById(fieldId(f));
      if (input) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
    }
    saveDraft();
  }

  function textField(f) {
    var id = fieldId(f);
    var tag = f.type === 'textarea' ? 'textarea' : 'input';
    var input = h(tag, {
      id: id,
      class: 'input',
      type: tag === 'input' ? (f.type === 'tel' ? 'tel' : 'text') : undefined,
      placeholder: f.placeholder,
      maxlength: String(f.max),
      autocomplete: f.type === 'tel' ? 'tel' : 'off',
      'aria-invalid': S.errors[f.key] ? 'true' : undefined,
      'aria-describedby': S.errors[f.key] ? id + '-err' : undefined,
      rows: tag === 'textarea' ? '4' : undefined
    });
    input.value = S.answers[f.key] || '';
    var preview = null;
    if (f.type === 'github') {
      preview = h('p', { class: 'hint gh-preview', 'aria-live': 'polite' });
      var show = function () {
        preview.textContent = '';
        var login = githubLogin(input.value);
        if (!login) return;
        preview.appendChild(document.createTextNode('확인: '));
        preview.appendChild(h('a', { href: 'https://github.com/' + encodeURIComponent(login), target: '_blank', rel: 'noopener noreferrer', text: 'github.com/' + login }));
      };
      show();
      input.addEventListener('input', show);
    }
    input.addEventListener('input', function () { update(f, input.value); });
    var chips = (f.chips || []).length
      ? h('div', { class: 'chips' }, f.chips.map(function (c) {
          return h('button', { type: 'button', class: 'chip', text: c, onclick: function () {
            var cur = String(input.value || '').trim();
            var parts = cur ? cur.split(/\s*,\s*/) : [];
            if (parts.indexOf(c) === -1) parts.push(c);
            input.value = parts.join(', ');
            update(f, input.value);
            if (preview) input.dispatchEvent(new Event('input'));
          } });
        }))
      : null;
    return [input, chips, preview];
  }

  function choiceField(f) {
    var multi = f.type === 'multi';
    var current = multi ? (Array.isArray(S.answers[f.key]) ? S.answers[f.key] : []) : S.answers[f.key];
    var all = (f.options || []).concat(f.solo || []);
    return [h('div', { class: 'choices', role: multi ? 'group' : 'radiogroup', 'aria-labelledby': fieldId(f) + '-label' }, all.map(function (opt) {
      var on = multi ? current.indexOf(opt) > -1 : current === opt;
      return h('button', {
        type: 'button',
        class: 'choice' + (on ? ' on' : ''),
        role: multi ? 'checkbox' : 'radio',
        'aria-checked': on ? 'true' : 'false',
        text: opt,
        onclick: function () {
          if (!multi) { update(f, opt); render(); return; }
          var isSolo = (f.solo || []).indexOf(opt) > -1;
          var next = current.slice();
          if (next.indexOf(opt) > -1) next = next.filter(function (x) { return x !== opt; });
          else if (isSolo) next = [opt];
          else next = next.filter(function (x) { return (f.solo || []).indexOf(x) === -1; }).concat([opt]);
          update(f, next);
          render();
        }
      });
    }))];
  }

  function fieldNode(f) {
    var id = fieldId(f);
    var choice = f.type === 'single' || f.type === 'multi';
    var label = h(choice ? 'p' : 'label', { class: 'label', id: id + '-label', for: choice ? undefined : id }, [
      f.key, f.required ? h('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null,
      f.required ? h('span', { class: 'sr-only', text: ' (필수)' }) : null
    ]);
    var body = choice ? choiceField(f) : textField(f);
    return h('div', { class: 'field' + (f.full ? ' full' : '') }, [label].concat(body, [errorNode(f)]));
  }

  /* ----------------------------------------------------------- render */

  function fmt(iso) {
    var d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  function render() {
    root.textContent = '';
    var form = S.form;
    var ev = form.event;
    document.title = ev.title;
    root.appendChild(h('header', { class: 'head' }, [h('h1', { text: ev.title }), ev.intro ? lines(ev.intro, 'intro') : null]));
    if (DEMO) root.appendChild(h('p', { class: 'banner', text: '미리보기 모드: config.js 가 비어 있어 아무 데도 보내지 않습니다.' }));

    var gate = form.gate || { state: 'open' };
    if (gate.state !== 'open' && !DEMO) {
      root.appendChild(h('section', { class: 'card closed' }, [
        h('h2', { text: gate.state === 'before' ? '아직 신청 기간이 아닙니다' : '신청이 마감되었습니다' }),
        h('p', { text: gate.state === 'before' ? fmt(gate.openAt) + ' 에 열립니다.' : fmt(gate.closeAt) + ' 에 마감되었습니다.' })
      ]));
      return;
    }
    if (gate.closeAt) root.appendChild(h('p', { class: 'deadline', text: '마감: ' + fmt(gate.closeAt) }));

    if (!S.user) {
      var slot = h('div', { class: 'signin' });
      root.appendChild(h('section', { class: 'card' }, [h('h2', { text: '구글 계정으로 로그인' }), h('p', { class: 'hint', text: '이메일은 로그인한 계정에서 가져옵니다. 같은 계정으로 다시 오면 제출한 내용을 고칠 수 있습니다.' }), slot]));
      if (DEMO) slot.appendChild(h('button', { type: 'button', class: 'btn', text: '데모 계정으로 시작', onclick: function () { S.user = { email: 'demo@example.com', name: '데모', token: 'demo' }; loadMine(); } }));
      else mountGoogleButton(slot);
      return;
    }

    root.appendChild(h('div', { class: 'who' }, [
      h('span', { text: S.user.email + (S.found ? ' · 제출한 내용을 고치는 중' : '') }),
      h('button', { type: 'button', class: 'link', text: '로그아웃', onclick: logout })
    ]));

    var formEl = h('form', { class: 'form', novalidate: true, onsubmit: function (e) { e.preventDefault(); submit(); } });
    form.sections.forEach(function (s, i) {
      formEl.appendChild(h('fieldset', { class: 'card section' }, [
        h('legend', {}, [h('span', { class: 'no', text: String(i + 1).padStart(2, '0') }), s.name, s.optional ? h('span', { class: 'opt', text: '선택' }) : null]),
        s.hint ? lines(s.hint, 'hint') : null,
        h('div', { class: 'grid' }, s.fields.map(fieldNode))
      ]));
    });
    if (ev.privacy) {
      formEl.appendChild(h('p', { class: 'privacy' }, [ev.privacy, ev.privacyUrl ? ' ' : null, ev.privacyUrl ? h('a', { href: ev.privacyUrl, target: '_blank', rel: 'noopener noreferrer', text: '개인정보 처리방침' }) : null]));
    }
    formEl.appendChild(h('div', { class: 'actions' }, [
      h('button', { type: 'submit', class: 'btn', disabled: S.busy, text: S.busy ? '보내는 중…' : (S.found ? '수정해서 제출' : '제출') }),
      h('p', { id: 'status', class: 'status', role: 'status', 'aria-live': 'polite' })
    ]));
    root.appendChild(formEl);
  }

  /* ----------------------------------------------------------- flows */

  function loadMine() {
    saveSession();
    render();
    setStatus('', '이전에 제출한 내용을 확인하는 중…');
    post({ action: 'me', idToken: S.user.token }, 20000).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'FAILED');
      S.found = !!res.found;
      S.answers = res.found ? res.answers : (loadDraft() || {});
      render();
      setStatus('', res.found ? '제출한 내용을 불러왔습니다. 고친 뒤 다시 제출하면 덮어씁니다.' : '');
    }).catch(function (err) {
      if (String(err.message) === 'AUTH_FAILED') { logout(); setStatus('bad', '로그인이 만료되었습니다. 다시 로그인해 주세요.'); return; }
      S.answers = loadDraft() || {};
      render();
      setStatus('bad', '이전 제출 내용을 불러오지 못했습니다. 새로 작성할 수 있습니다.');
    });
  }

  function newNonce() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function submit() {
    if (S.busy) return;
    if (!DEMO && !fresh(S.user)) { logout(); setStatus('bad', '로그인이 만료되었습니다. 다시 로그인한 뒤 제출해 주세요. 작성한 내용은 남아 있습니다.'); return; }
    var checked = validate(S.answers);
    S.errors = {};
    checked.errors.forEach(function (e) { S.errors[e.key] = e.reason; });
    if (checked.errors.length) {
      render();
      setStatus('bad', '확인이 필요한 항목이 ' + checked.errors.length + '개 있습니다.');
      var first = document.querySelector('[aria-invalid="true"], .error');
      if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' });
      return;
    }

    var body = { action: 'submit', idToken: S.user.token, nonce: newNonce(), answers: S.answers };
    S.busy = true; render(); setStatus('', '보내는 중…');

    // A lost response is retried once with the same nonce; the server applies it only once.
    post(body).catch(function () { return post(body); }).then(function (res) {
      S.busy = false;
      if (res.ok) {
        S.found = true; clearDraft(); render();
        setStatus('ok', res.updated ? '수정한 내용이 저장되었습니다.' : '신청이 접수되었습니다. 감사합니다!');
        return;
      }
      if (res.error === 'INVALID') {
        (res.fields || []).forEach(function (e) { S.errors[e.key] = e.reason; });
        render(); setStatus('bad', '서버에서 확인이 필요한 항목을 찾았습니다.');
      } else if (res.error === 'CLOSED' || res.error === 'NOT_OPEN_YET') {
        S.form.gate = res.gate || S.form.gate; render();
      } else if (res.error === 'AUTH_FAILED') {
        logout(); setStatus('bad', '로그인이 만료되었습니다. 다시 로그인한 뒤 제출해 주세요. 작성한 내용은 남아 있습니다.');
      } else {
        render(); setStatus('bad', '저장하지 못했습니다 (' + res.error + '). 잠시 뒤 다시 시도해 주세요.');
      }
    }, function () {
      S.busy = false; render();
      setStatus('bad', '응답을 받지 못했습니다. 저장됐을 수도 있으니 새로 고친 뒤 확인해 주세요. 작성한 내용은 이 브라우저에 남아 있습니다.');
    });
  }

  /* ------------------------------------------------------------ start */

  try { S.user = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { S.user = null; }
  if (!DEMO && !fresh(S.user)) S.user = null;

  getForm().then(function (form) {
    if (!form || !form.ok) throw new Error('NO_FORM');
    S.form = form;
    if (S.user) loadMine(); else render();
  }).catch(function () {
    root.textContent = '';
    root.appendChild(h('p', { class: 'status bad', text: '신청서를 불러오지 못했습니다. 잠시 뒤 새로 고쳐 주세요.' }));
  });

  window.SHO = { validate: validate, githubLogin: githubLogin, state: S };
})();
