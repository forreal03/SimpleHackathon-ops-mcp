/**
 * SimpleHackathon forms — application backend (Google Apps Script web app).
 *
 * Adapted from the ENDPoinT 2026 site (2026ENDPoinT.github.io). The questions, the period and the
 * sheet live in Config.gs; secrets live in Script properties. Deploy as a web app
 * (Execute as: Me, Who has access: Anyone). The site talks to it with plain fetch:
 *
 *   GET  ?form=1                         → event, period state and questions (public)
 *   POST { action: "me", idToken }       → this account's earlier answers
 *   POST { action: "submit", idToken, nonce, answers } → validate and write one row
 *
 * Safety: the Google ID token is verified with Google on every request, the e-mail comes from the
 * token (never from the form), only configured columns are written, the period is enforced here,
 * cells are written as text so "=…" is never a formula, and a retried request is applied once.
 */

var API_VERSION = 1;
var RESERVED = ['제출시각', '이메일', '계정 식별자'];

/** Per-execution memo; rebuilt on every request so users never share it. */
var MEMO = { props: null, ss: null, data: null };

/** Run once from the editor: checks the config, creates the tab and header row, grants permissions. */
function setup() {
  checkConfig_();
  var d = data_();
  Logger.log('Ready: tab "' + d.sheet.getName() + '" with ' + (d.lastRow - 1) + ' answers. Columns: ' + d.headers.join(', '));
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.form) return json_(publicForm_());
  return json_({ ok: true, service: 'simple-hackathon forms', api: API_VERSION });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var claims = verifyIdToken_(body.idToken);
    if (!claims) return json_({ ok: false, error: 'AUTH_FAILED' });

    var action = body.action || 'submit';
    if (action === 'me') return json_(findMine_(claims));
    if (action !== 'submit') return json_({ ok: false, error: 'UNKNOWN_ACTION' });

    // The page hides the form outside the period, but anyone can call the endpoint directly.
    var gate = gateState_();
    if (gate.state !== 'open') return json_({ ok: false, error: gate.state === 'before' ? 'NOT_OPEN_YET' : 'CLOSED', gate: gate });

    var checked = validate_(body.answers || {});
    if (checked.errors.length) return json_({ ok: false, error: 'INVALID', fields: checked.errors });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      return json_(once_(claims, body.nonce, function () { return submit_(claims, checked.clean); }));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: 'SERVER_ERROR', detail: String(err && err.message || err) });
  }
}

/* ----------------------------------------------------------- config */

function props_() {
  if (!MEMO.props) MEMO.props = PropertiesService.getScriptProperties().getProperties() || {};
  return MEMO.props;
}

function fields_() {
  var out = [];
  FORM.forEach(function (section) { (section.fields || []).forEach(function (f) { out.push(f); }); });
  return out;
}

function checkConfig_() {
  if (!props_().CLIENT_ID) throw new Error('Set the CLIENT_ID script property (Project Settings → Script properties).');
  var seen = {};
  fields_().forEach(function (f) {
    if (!f.key) throw new Error('Every field needs a key.');
    if (RESERVED.indexOf(f.key) > -1) throw new Error('"' + f.key + '" is reserved for the server.');
    if (seen[f.key]) throw new Error('Two fields share the key "' + f.key + '".');
    seen[f.key] = true;
    if ((f.type === 'single' || f.type === 'multi') && !(f.options || []).length && !(f.solo || []).length) {
      throw new Error('"' + f.key + '" needs options.');
    }
  });
}

/** Columns in order: submit time, e-mail, every configured field, account id. */
function headers_() {
  return ['제출시각', '이메일'].concat(fields_().map(function (f) { return f.key; })).concat(['계정 식별자']);
}

function gateState_() {
  var now = Date.now();
  var open = GATE.openAt ? Date.parse(GATE.openAt) : NaN;
  var close = GATE.closeAt ? Date.parse(GATE.closeAt) : NaN;
  var state = 'open';
  if (!isNaN(open) && now < open) state = 'before';
  else if (!isNaN(close) && now >= close) state = 'after';
  return { state: state, openAt: GATE.openAt || null, closeAt: GATE.closeAt || null };
}

/** Everything the page needs to draw the form. Nothing secret. */
function publicForm_() {
  return {
    ok: true,
    api: API_VERSION,
    event: { title: EVENT.title, intro: EVENT.intro || '', privacy: EVENT.privacy || '', privacyUrl: EVENT.privacyUrl || '' },
    gate: gateState_(),
    sections: FORM.map(function (s) {
      return {
        name: s.name,
        hint: s.hint || '',
        optional: !!s.optional,
        fields: (s.fields || []).map(function (f) {
          return {
            key: f.key, type: f.type || 'text', required: !!f.required, placeholder: f.placeholder || '',
            options: f.options || [], solo: f.solo || [], chips: f.chips || [], max: maxLen_(f), full: !!f.full
          };
        })
      };
    })
  };
}

/* ------------------------------------------------------- validation */

function maxLen_(f) {
  return f.max || (f.type === 'textarea' ? 2000 : 200);
}

/** "@octocat", "https://github.com/octocat/" → "octocat"; null when it cannot be a GitHub username. */
function githubLogin_(value) {
  var s = String(value || '').trim().replace(/^@/, '');
  var url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/?#\s]+)/i);
  if (url) s = url[1];
  s = s.replace(/\/+$/, '');
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(s) ? s : null;
}

/**
 * Checks answers against FORM. Unknown keys are dropped, so a participant cannot add columns.
 * Returns { clean, errors: [{ key, reason }] }.
 */
function validate_(answers) {
  var clean = {}, errors = [];
  fields_().forEach(function (f) {
    var raw = answers[f.key];
    var type = f.type || 'text';
    var bad = function (reason) { errors.push({ key: f.key, reason: reason }); };

    if (type === 'multi') {
      var list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      list = list.map(function (x) { return String(x).trim(); }).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
      var allowed = (f.options || []).concat(f.solo || []);
      if (list.some(function (x) { return allowed.indexOf(x) === -1; })) return bad('not_an_option');
      var solo = list.filter(function (x) { return (f.solo || []).indexOf(x) > -1; });
      if (solo.length && list.length > 1) return bad('exclusive_choice');
      if (f.required && !list.length) return bad('required');
      clean[f.key] = list;
      return;
    }

    var text = raw === null || raw === undefined ? '' : String(raw);
    text = type === 'textarea' ? text.replace(/\r\n/g, '\n').trim() : text.replace(/\s+/g, ' ').trim();
    if (!text) {
      if (f.required) bad('required');
      clean[f.key] = '';
      return;
    }
    if (text.length > maxLen_(f)) return bad('too_long');

    if (type === 'single' && (f.options || []).indexOf(text) === -1) return bad('not_an_option');
    if (type === 'tel' && !/^[0-9+\-() ]{7,20}$/.test(text)) return bad('not_a_phone_number');
    if (type === 'github') {
      var login = githubLogin_(text);
      if (!login) return bad('not_a_github_username');
      text = login;
    }
    clean[f.key] = text;
  });
  return { clean: clean, errors: errors };
}

/* ------------------------------------------------------------ sheet */

function ss_() {
  if (MEMO.ss) return MEMO.ss;
  var id = props_().SHEET_ID;
  MEMO.ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!MEMO.ss) throw new Error('No spreadsheet: bind this script to a sheet or set the SHEET_ID script property.');
  return MEMO.ss;
}

/** Reads the tab once per request; adds the configured columns it is missing (never others). */
function data_() {
  if (MEMO.data) return MEMO.data;
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET.name) || ss.insertSheet(SHEET.name);
  var want = headers_();
  var lastCol = sh.getLastColumn();
  var headers = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  var missing = want.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
    sh.setFrozenRows(1);
  }
  var lastRow = sh.getLastRow();
  var values = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  return (MEMO.data = { sheet: sh, headers: headers, values: values, lastRow: Math.max(lastRow, 1) });
}

/** Row of this account (by Google account id, then e-mail), or 0. */
function findRow_(d, claims) {
  var subCol = d.headers.indexOf('계정 식별자');
  var mailCol = d.headers.indexOf('이메일');
  var sub = String(claims.sub || '').toLowerCase();
  var mail = String(claims.email || '').toLowerCase();
  var byMail = 0;
  for (var i = 0; i < d.values.length; i++) {
    if (subCol > -1 && sub && String(d.values[i][subCol]).toLowerCase() === sub) return i + 2;
    if (!byMail && mailCol > -1 && mail && String(d.values[i][mailCol]).toLowerCase() === mail) byMail = i + 2;
  }
  return byMail;
}

function submit_(claims, clean) {
  var d = data_();
  var record = {};
  Object.keys(clean).forEach(function (k) { record[k] = clean[k]; });
  record['제출시각'] = new Date();
  record['이메일'] = claims.email;
  record['계정 식별자'] = claims.sub;

  var row = d.headers.map(function (h) { return toCell_(record[h]); });
  var target = SHEET.updateIfExists ? findRow_(d, claims) : 0;
  var isNew = !(target > 0);
  if (isNew) target = d.lastRow + 1;

  var range = d.sheet.getRange(target, 1, 1, row.length);
  // Text format everywhere (no formulas, long ids keep their digits); a date for the submit time.
  range.setNumberFormats([d.headers.map(function (h) { return h === '제출시각' ? 'yyyy-mm-dd hh:mm:ss' : '@'; })]);
  range.setValues([row]);
  SpreadsheetApp.flush();
  return { ok: true, updated: !isNew };
}

/** This account's earlier answers, to fill the form for editing. The account id is not returned. */
function findMine_(claims) {
  var d = data_();
  var row = findRow_(d, claims);
  if (!row) return { ok: true, found: false };
  var values = d.values[row - 2] || [];
  var answers = {};
  d.headers.forEach(function (h, i) {
    if (h === '계정 식별자') return;
    var v = values[i];
    answers[h] = v instanceof Date ? v.toISOString() : v;
  });
  // Multi-choice answers are stored as "a, b"; hand them back as lists.
  fields_().forEach(function (f) {
    if (f.type === 'multi' && typeof answers[f.key] === 'string') {
      answers[f.key] = answers[f.key] ? answers[f.key].split(/\s*,\s*/) : [];
    }
  });
  return { ok: true, found: true, answers: answers };
}

/* --------------------------------------------------------- helpers */

/** Applies a request once even if the page resends it after a lost response. */
function once_(claims, nonce, fn) {
  if (!nonce) return fn();
  var cache = null, key = null;
  try {
    cache = CacheService.getScriptCache();
    key = 'once:' + String(claims.sub) + ':' + String(nonce).slice(0, 64);
    var hit = cache.get(key);
    if (hit) {
      var prev = JSON.parse(hit);
      prev.replay = true;
      return prev;
    }
  } catch (e) { cache = null; }
  var res = fn();
  if (cache && res && res.ok) { try { cache.put(key, JSON.stringify(res), 600); } catch (e2) {} }
  return res;
}

/** Asks Google whether the ID token is real, for this site, and for a verified e-mail. */
function verifyIdToken_(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) return null;
  var cache = null, key = null;
  try {
    cache = CacheService.getScriptCache();
    key = 'tok:' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) { cache = null; }

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  var p = JSON.parse(res.getContentText());
  var props = props_();
  if (!props.CLIENT_ID || p.aud !== props.CLIENT_ID) return null;
  if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') return null;
  if (String(p.email_verified) !== 'true' || !p.email) return null;
  if (Number(p.exp) * 1000 < Date.now()) return null;
  if (props.ALLOWED_DOMAIN) {
    var suffix = '@' + String(props.ALLOWED_DOMAIN).toLowerCase();
    if (String(p.email).toLowerCase().slice(-suffix.length) !== suffix) return null;
  }
  if (cache) {
    var left = Math.floor(Number(p.exp) - Date.now() / 1000) - 30;
    if (left > 0) { try { cache.put(key, JSON.stringify(p), Math.min(left, 300)); } catch (e2) {} }
  }
  return p;
}

/** Strips leading "=" (and spaces before it) so a cell is never a formula. */
function safeText_(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/^[=\s]+/, function (m) { return m.replace(/=/g, ''); });
}

function toCell_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return safeText_(v.map(safeText_).join(', '));
  if (typeof v === 'boolean') return v ? 'O' : '';
  if (typeof v === 'number') return v;
  return safeText_(v);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
