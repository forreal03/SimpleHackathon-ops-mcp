// Runs Config.gs + Code.gs in a sandbox with small fakes of the Apps Script services.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps-script");

class FakeSheet {
  constructor(name) { this.name = name; this.cells = []; this.formats = []; }
  getName() { return this.name; }
  getLastRow() { return this.cells.length; }
  getLastColumn() { return this.cells.reduce((m, r) => Math.max(m, r.length), 0); }
  setFrozenRows() {}
  getRange(row, col, rows = 1, cols = 1) {
    const sheet = this;
    return {
      getValues() {
        return Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => sheet.cells[row - 1 + i]?.[col - 1 + j] ?? ""));
      },
      setValues(values) {
        values.forEach((r, i) => r.forEach((v, j) => {
          const line = (sheet.cells[row - 1 + i] ??= []);
          line[col - 1 + j] = v;
        }));
      },
      setNumberFormats(f) { sheet.formats[row - 1] = f[0]; },
    };
  }
}

export function loadBackend({ props = { CLIENT_ID: "cid" }, tokens = {}, gate } = {}) {
  const sheets = new Map();
  const cache = new Map();
  const fetched = [];
  const ss = {
    getSheetByName: (n) => sheets.get(n) ?? null,
    insertSheet: (n) => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
  };
  const ctx = {
    console,
    Date, JSON, Math, String, Number, Array, Object, RegExp, Error, isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush: () => {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      computeDigest: (_a, s) => [...createHash("sha256").update(s).digest()],
      base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
    },
    UrlFetchApp: {
      fetch(url) {
        fetched.push(url);
        const token = decodeURIComponent(url.split("id_token=")[1]);
        const info = tokens[token];
        return { getResponseCode: () => (info ? 200 : 400), getContentText: () => JSON.stringify(info ?? {}) };
      },
    },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }) },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(dir, "Config.gs"), "utf8"), ctx, { filename: "Config.gs" });
  vm.runInContext(readFileSync(path.join(dir, "Code.gs"), "utf8"), ctx, { filename: "Code.gs" });
  if (gate) vm.runInContext(`GATE = ${JSON.stringify(gate)};`, ctx);

  const call = (fn, arg) => {
    vm.runInContext("MEMO = { props: null, ss: null, data: null };", ctx); // fresh per request, like Apps Script
    return JSON.parse(ctx[fn](arg).body);
  };
  return {
    ctx,
    sheets,
    fetched,
    get: (params) => call("doGet", { parameter: params }),
    post: (body) => call("doPost", { postData: { contents: JSON.stringify(body) } }),
  };
}

export const token = (email, sub, extra = {}) => ({
  aud: "cid", iss: "https://accounts.google.com", email, email_verified: "true", sub, exp: String(Math.floor(Date.now() / 1000) + 3600), ...extra,
});
