// @vitest-environment jsdom
// The page (site/index.html + assets/app.js) in jsdom: demo mode, the closed period, escaping,
// and a live run against a fake Apps Script server and a fake Google sign-in.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBackend } from "./gas-harness.mjs";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const read = (f) => readFileSync(path.join(site, f), "utf8");
const body = read("index.html").match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "");
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Loads the page as a visitor would: config.js (optionally changed), demo-form.js, app.js. */
async function open({ url = "/", config, demo, google } = {}) {
  window.history.replaceState(null, "", url);
  document.body.innerHTML = body;
  sessionStorage.clear();
  localStorage.clear();
  delete window.SHO;
  delete window.google;
  window.eval(read("config.js"));
  if (config) config(window.SHO_CONFIG);
  window.eval(read("demo-form.js"));
  if (demo) demo(window.SHO_DEMO_FORM);
  if (google) window.google = google;
  window.eval(read("assets/app.js"));
  await window.SHO.ready();
  await tick();
}

const $ = (sel) => document.querySelector(sel);
const fields = () => [...document.querySelectorAll("#af .fld")];
const inputs = (key) => [...document.querySelectorAll("#af [data-k]")].filter((n) => n.getAttribute("data-k") === key);

/** Types or ticks an answer the way a person would, so the page's own listeners run. */
function answer(key, value) {
  for (const n of inputs(key)) {
    if (n.type === "checkbox" || n.type === "radio") {
      if ([].concat(value).includes(n.value)) {
        n.checked = true;
        n.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else {
      n.value = value;
      n.dispatchEvent(new Event("input", { bubbles: true }));
      n.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}
function fillAll(github = "@octocat") {
  answer("성함", "홍길동");
  answer("연락처", "010-1234-5678");
  answer("학번", "26101234");
  answer("학년", "1학년");
  answer("GitHub 아이디", github);
  answer("소속", ["동아리 A", "동아리 B"]);
  answer("희망역할", "백엔드");
  answer("기술스택 및 개발 경험", "TypeScript");
  answer("팀 보유 여부 및 팀원", "없음");
  answer("참석 불가 일정", ["모든 일정 참석 가능"]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("site in demo mode (config.js empty)", () => {
  it("draws the ENDPoinT layout from config.js and the questions, locked until sign-in", async () => {
    await open();
    expect(document.title).toBe("참가 신청 · My Hackathon");
    expect($("#brand b").textContent).toBe("My Hackathon");
    expect($("#head-stats").textContent).toContain("10.07 – 10.31");
    expect(document.querySelectorAll("#steps .slot")).toHaveLength(4);
    expect($("#steps .slot").textContent).toContain("10.31 23:59까지");
    expect(document.querySelectorAll("#notices .slot")).toHaveLength(3);
    expect(fields()).toHaveLength(8);
    expect(fields()[1].querySelector(".fld-name").textContent).toContain("GitHub 아이디");
    expect($("#af").classList.contains("locked")).toBe(true);
    expect($("#af-go").disabled).toBe(true);

    $("#af-auth [data-demo]").click();
    expect($("#af").classList.contains("locked")).toBe(false);
    expect($("#top-auth").textContent).toContain("데모 참가자");
  });

  it("checks the GitHub id like the server and links to the profile", async () => {
    await open();
    $("#af-auth [data-demo]").click();
    answer("GitHub 아이디", "https://github.com/Octo-Cat/");
    const [gh] = inputs("GitHub 아이디");
    expect(gh.value).toBe("Octo-Cat");
    expect($('[data-gh] a').getAttribute("href")).toBe("https://github.com/Octo-Cat");
    expect(fields()[1].classList.contains("done")).toBe(true);

    answer("GitHub 아이디", "not a login!");
    expect(gh.getAttribute("aria-invalid")).toBe("true");
    expect($("[data-gh]").textContent).toContain("GitHub 아이디 형식이 아닙니다");
    expect(fields()[1].classList.contains("done")).toBe(false);

    expect(window.SHO.githubLogin("@octocat")).toBe("octocat");
    expect(window.SHO.githubLogin("-bad")).toBeNull();
    expect(window.SHO.githubLogin("a".repeat(40))).toBeNull();
  });

  it("points at the first unfinished section, then finishes with a recap", async () => {
    await open();
    $("#af-auth [data-demo]").click();
    answer("성함", "홍길동");
    expect($("#af-go").disabled).toBe(true);

    fillAll();
    answer("연락처", "abc");
    expect($("#af-go").disabled).toBe(true);
    answer("연락처", "010-1234-5678");
    expect($("#af-n").textContent).toBe("8 / 8");
    expect($("#af-go").disabled).toBe(false);

    vi.spyOn(console, "log").mockImplementation(() => {});
    $("#af-go").click();
    await new Promise((r) => setTimeout(r, 750));
    expect($("#af-done").classList.contains("on")).toBe(true);
    const recap = $("#af-done .af-recap").textContent;
    expect(recap).toContain("demo@example.com");
    expect(recap).toContain("octocat");
    expect(recap).not.toContain("010-1234-5678");
  });

  it("shows the closed panel instead of the form, without a sign-in button", async () => {
    await open({ url: "/?gate=closed" });
    expect($("#af").hidden).toBe(true);
    expect($("#af-gate").hidden).toBe(false);
    expect($("#af-gate").textContent).toContain("모집 기간에 열립니다");
    expect($("#nav-apply").textContent).toBe("10.07 오픈");
    expect($("#nav-apply").hasAttribute("href")).toBe(false);
    expect($("#top-auth").textContent).toBe("");

    await open({ url: "/?gate=after" });
    expect($("#af-gate").textContent).toContain("모집이 마감되었습니다");
    expect($("#nav-apply").textContent).toBe("모집 마감");
  });

  it("never turns config or server text into HTML or script links", async () => {
    await open({
      config: (c) => {
        c.BRAND.name = '<img src=x onerror="window.pwned=1">';
        c.STEPS.items[0].text = "**굵게** [나쁜 링크](javascript:window.pwned=2) [좋은 링크](https://example.com) <b>x</b>";
      },
      demo: (f) => {
        f.sections[0].hint = "<script>window.pwned=3</script> https://example.com/a?b=1&c=2";
        f.sections[2].fields[0].options[0] = '<img src=x onerror="window.pwned=4">';
      },
    });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("#af script")).toBeNull();
    expect($("#brand b").textContent).toContain("<img");
    const links = [...document.querySelectorAll("#steps .slot a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([null, "https://example.com"]);
    expect($("#steps .slot strong").textContent).toBe("굵게");
    expect($("#steps .slot p").textContent).toContain("<b>x</b>");
    expect($('#af .qhint a[href^="https://example.com/a?b=1&c=2"]')).toBeTruthy();
    expect(window.pwned).toBeUndefined();
  });

  it("uses the same questions as Config.gs", () => {
    window.eval(read("demo-form.js"));
    const server = loadBackend().get({ form: "1" });
    expect(window.SHO_DEMO_FORM.sections).toEqual(server.sections);
    expect(window.SHO_DEMO_FORM.event).toEqual(server.event);
  });
});

describe("site against a live backend", () => {
  const ENDPOINT = "https://script.example/macros/s/x/exec";
  const jwt = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

  function fakeGoogle() {
    const g = { callback: null };
    g.accounts = { id: {
      initialize: (o) => { g.callback = o.callback; },
      renderButton: (el) => { el.textContent = "Google 로그인"; },
      disableAutoSelect: () => {},
    } };
    return g;
  }

  /** fetch that answers GET ?form=1 from demo-form.js and POSTs with `reply(body)`. */
  function fakeServer(reply) {
    const posts = [];
    const fetch = vi.fn(async (url, init) => {
      if (!init || !init.method) {
        expect(url).toBe(ENDPOINT + "?form=1");
        const form = JSON.parse(JSON.stringify(window.SHO_DEMO_FORM));
        form.gate = { state: "open", openAt: "2026-10-07T08:00:00+09:00", closeAt: "2026-10-31T23:59:59+09:00" };
        return { ok: true, json: async () => form };
      }
      const req = JSON.parse(init.body);
      posts.push(req);
      expect(init.headers["Content-Type"]).toMatch(/^text\/plain/);
      const res = reply(req, posts.length);
      return { ok: true, status: 200, text: async () => JSON.stringify(res) };
    });
    window.fetch = globalThis.fetch = fetch;
    return posts;
  }

  async function signIn(google) {
    await vi.waitFor(() => expect(google.callback).toBeTypeOf("function"));
    google.callback({ credential: jwt({ email: "a@x.com", name: "홍길동", sub: "111", exp: Math.floor(Date.now() / 1000) + 3600 }) });
    await tick();
  }

  it("asks for earlier answers, shows server-side field errors, then submits once with a nonce", async () => {
    const posts = fakeServer((req, n) => {
      if (req.action === "me") return { ok: true, found: false };
      if (n === 2) return { ok: false, error: "INVALID", fields: [{ key: "GitHub 아이디", reason: "not_a_github_username" }] };
      return { ok: true, updated: false };
    });
    const google = fakeGoogle();
    await open({ config: (c) => { c.CLIENT_ID = "cid.apps.googleusercontent.com"; c.ENDPOINT = ENDPOINT; }, google });
    expect($("#af-auth").textContent).toBe("Google 로그인");

    await signIn(google);
    await vi.waitFor(() => expect(posts.map((p) => p.action)).toEqual(["me"]));
    expect(posts[0].idToken).toMatch(/^e30\./);

    fillAll("@octocat");
    $("#af-go").click();
    await vi.waitFor(() => expect($("#af-msg").textContent).toContain("GitHub 아이디 형식이 아닙니다"));
    expect(fields()[1].classList.contains("bad")).toBe(true);
    expect(posts[1]).toMatchObject({ action: "submit", answers: { "GitHub 아이디": "octocat", "소속": ["동아리 A", "동아리 B"] } });
    expect(posts[1].nonce).toBeTruthy();

    $("#af-go").click();
    await vi.waitFor(() => expect($("#af-done").classList.contains("on")).toBe(true));
    expect($("#af-done h3").textContent).toBe("신청이 접수되었습니다");
    expect(posts[2].nonce).not.toBe(posts[1].nonce);
  });

  it("opens an earlier application read-only, with an edit button", async () => {
    fakeServer((req) => req.action === "me"
      ? { ok: true, found: true, answers: { "제출시각": "2026-10-08T01:02:03.000Z", "이메일": "a@x.com", "성함": "홍길동", "GitHub 아이디": "octocat", "소속": ["동아리 B"], "학년": "2학년" } }
      : { ok: true });
    const google = fakeGoogle();
    await open({ config: (c) => { c.CLIENT_ID = "cid"; c.ENDPOINT = ENDPOINT; }, google });
    await signIn(google);
    await vi.waitFor(() => expect($("#af-state").hidden).toBe(false));
    expect($("#af-state").textContent).toContain("접수되었습니다");
    expect(inputs("성함")[0].value).toBe("홍길동");
    expect(inputs("성함")[0].disabled).toBe(true);
    expect(inputs("소속").find((n) => n.value === "동아리 B").checked).toBe(true);
    expect($("#af-edit").hidden).toBe(false);

    $("#af-edit").click();
    expect(inputs("성함")[0].disabled).toBe(false);
    expect($("#af-go").textContent).toBe("수정 내용 저장");
  });

  it("says so when the questions cannot be loaded", async () => {
    window.fetch = globalThis.fetch = vi.fn(async () => { throw new Error("offline"); });
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = body;
    delete window.SHO;
    window.eval(read("config.js"));
    window.SHO_CONFIG.CLIENT_ID = "cid";
    window.SHO_CONFIG.ENDPOINT = ENDPOINT;
    window.eval(read("demo-form.js"));
    window.eval(read("assets/app.js"));
    await window.SHO.ready();
    expect($("#af").textContent).toContain("신청서를 불러오지 못했습니다");
  });
});
