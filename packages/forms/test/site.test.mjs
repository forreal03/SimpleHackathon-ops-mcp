// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const load = (f) => window.eval(readFileSync(path.join(site, f), "utf8"));
const flush = () => new Promise((r) => setTimeout(r, 0));

async function start(form) {
  document.body.innerHTML = '<main id="app"></main>';
  sessionStorage.clear();
  localStorage.clear();
  window.SHO_CONFIG = { CLIENT_ID: "", ENDPOINT: "" };
  load("demo-form.js");
  if (form) form(window.SHO_DEMO_FORM);
  load("app.js");
  await flush();
}

const byText = (sel, text) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim() === text);

describe("forms site (demo mode)", () => {
  beforeEach(() => start());

  it("renders every section and the GitHub field after sign-in", async () => {
    byText("button", "데모 계정으로 시작").click();
    await flush();
    expect(document.querySelectorAll("fieldset.section")).toHaveLength(8);
    expect(byText("label", "GitHub 아이디 * (필수)")).toBeTruthy();
  });

  it("shows field errors, then saves once the answers are fixed", async () => {
    byText("button", "데모 계정으로 시작").click();
    await flush();
    document.querySelector("form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(document.querySelectorAll(".error").length).toBeGreaterThan(5);

    const S = window.SHO.state;
    Object.assign(S.answers, {
      "성함": "홍길동", "연락처": "010-1234-5678", "학번": "26101234", "학년": "1학년", "GitHub 아이디": "@octocat",
      "소속": ["소속 없음"], "희망역할": "백엔드", "기술스택 및 개발 경험": "JS", "팀 보유 여부 및 팀원": "없음", "참석 불가 일정": ["모든 일정 참석 가능"],
    });
    S.errors = {};
    document.querySelector("form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(document.getElementById("status").textContent).toMatch(/접수되었습니다/);
  });

  it("validates GitHub usernames like the server", () => {
    expect(window.SHO.githubLogin("https://github.com/Octo-Cat/")).toBe("Octo-Cat");
    expect(window.SHO.githubLogin("bad login")).toBeNull();
    expect(window.SHO.githubLogin("-bad")).toBeNull();
  });

  it("never turns text from the server into HTML", async () => {
    await start((form) => {
      form.event.title = '<img src=x onerror="window.pwned=1">';
      form.sections[0].hint = "<script>window.pwned=2</script>";
    });
    byText("button", "데모 계정으로 시작").click();
    await flush();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("main script")).toBeNull();
    expect(window.pwned).toBeUndefined();
    expect(document.querySelector("h1").textContent).toContain("<img");
  });
});
