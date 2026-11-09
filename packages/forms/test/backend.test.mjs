import { describe, expect, it } from "vitest";
import { loadBackend, token } from "./gas-harness.mjs";

const OPEN = { openAt: "", closeAt: "" };
const good = {
  "성함": "홍길동", "연락처": "010-1234-5678", "학번": "26101234", "학년": "1학년",
  "GitHub 아이디": "https://github.com/octocat/", "소속": ["동아리 A", "동아리 B"], "희망역할": "백엔드",
  "기술스택 및 개발 경험": "TypeScript", "팀 보유 여부 및 팀원": "없음", "참석 불가 일정": ["모든 일정 참석 가능"],
};

function backend(extra = {}) {
  return loadBackend({ tokens: { "tok-a": token("a@x.com", "111"), "tok-b": token("b@x.com", "222"), "tok-aud": token("c@x.com", "333", { aud: "other" }) }, gate: OPEN, ...extra });
}

describe("forms backend", () => {
  it("serves the questions without secrets", () => {
    const b = loadBackend({ props: { CLIENT_ID: "cid", SHEET_ID: "secret-sheet" } });
    const form = b.get({ form: "1" });
    expect(form.ok).toBe(true);
    expect(form.sections.flatMap((s) => s.fields.map((f) => f.key))).toContain("GitHub 아이디");
    expect(JSON.stringify(form)).not.toContain("secret-sheet");
    expect(JSON.stringify(form)).not.toContain("cid");
  });

  it("writes one row per account, e-mail from the token, GitHub id normalised, extra keys dropped", () => {
    const b = backend();
    const res = b.post({ action: "submit", idToken: "tok-a", nonce: "n1", answers: { ...good, "이메일": "fake@evil.com", "새 열": "x" } });
    expect(res).toEqual({ ok: true, updated: false });
    const sheet = b.sheets.get("웹신청");
    const [headers, row] = sheet.cells;
    expect(headers).not.toContain("새 열");
    const at = (h) => row[headers.indexOf(h)];
    expect(at("이메일")).toBe("a@x.com");
    expect(at("GitHub 아이디")).toBe("octocat");
    expect(at("소속")).toBe("동아리 A, 동아리 B");
    expect(at("계정 식별자")).toBe("111");

    expect(b.post({ action: "submit", idToken: "tok-a", nonce: "n2", answers: { ...good, "희망역할": "프론트엔드" } }).updated).toBe(true);
    expect(sheet.cells).toHaveLength(2);
  });

  it("never writes a formula", () => {
    const b = backend();
    b.post({ action: "submit", idToken: "tok-a", answers: { ...good, "기술스택 및 개발 경험": "=IMPORTXML(\"http://x\")" } });
    const [headers, row] = b.sheets.get("웹신청").cells;
    expect(row[headers.indexOf("기술스택 및 개발 경험")]).toBe("IMPORTXML(\"http://x\")");
  });

  it("rejects bad input field by field", () => {
    const b = backend();
    const res = b.post({ action: "submit", idToken: "tok-a", answers: { ...good, "GitHub 아이디": "not a login!", "학년": "5학년", "소속": ["소속 없음", "동아리 A"], "연락처": "abc" } });
    expect(res.error).toBe("INVALID");
    expect(res.fields).toEqual([
      { key: "연락처", reason: "not_a_phone_number" },
      { key: "학년", reason: "not_an_option" },
      { key: "GitHub 아이디", reason: "not_a_github_username" },
      { key: "소속", reason: "exclusive_choice" },
    ]);
    expect(b.sheets.get("웹신청")).toBeUndefined();
  });

  it("enforces the period on the server", () => {
    const before = loadBackend({ tokens: { t: token("a@x.com", "1") }, gate: { openAt: "2999-01-01T00:00:00+09:00", closeAt: "" } });
    expect(before.post({ idToken: "t", answers: good }).error).toBe("NOT_OPEN_YET");
    const after = loadBackend({ tokens: { t: token("a@x.com", "1") }, gate: { openAt: "", closeAt: "2000-01-01T00:00:00+09:00" } });
    expect(after.post({ idToken: "t", answers: good }).error).toBe("CLOSED");
  });

  it("refuses tokens that are missing, for another site, or expired", () => {
    const b = backend({ tokens: { old: token("a@x.com", "1", { exp: "1000" }), "tok-aud": token("c@x.com", "3", { aud: "other" }) } });
    expect(b.post({ answers: good }).error).toBe("AUTH_FAILED");
    expect(b.post({ idToken: "tok-aud", answers: good }).error).toBe("AUTH_FAILED");
    expect(b.post({ idToken: "old", answers: good }).error).toBe("AUTH_FAILED");
    expect(b.post({ idToken: "x".repeat(5000), answers: good }).error).toBe("AUTH_FAILED");
  });

  it("applies a resent request once", () => {
    const b = backend();
    b.post({ action: "submit", idToken: "tok-b", nonce: "same", answers: good });
    const again = b.post({ action: "submit", idToken: "tok-b", nonce: "same", answers: good });
    expect(again.replay).toBe(true);
    expect(b.sheets.get("웹신청").cells).toHaveLength(2);
  });

  it("gives an account back its own answers only, lists as lists, without the account id", () => {
    const b = backend();
    b.post({ action: "submit", idToken: "tok-a", answers: good });
    const mine = b.post({ action: "me", idToken: "tok-a" });
    expect(mine.found).toBe(true);
    expect(mine.answers["소속"]).toEqual(["동아리 A", "동아리 B"]);
    expect(mine.answers["계정 식별자"]).toBeUndefined();
    expect(b.post({ action: "me", idToken: "tok-b" }).found).toBe(false);
    expect(b.post({ action: "delete", idToken: "tok-a" }).error).toBe("UNKNOWN_ACTION");
  });
});
