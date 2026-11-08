/** Pure checks run before a repo is made public. */

const SAFE_ENV = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/i;
const SECRET_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /(^|\/)\.env(\.[^/]+)?$/i, why: "environment file" },
  { re: /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i, why: "private key or keystore" },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, why: "SSH private key" },
  { re: /(^|\/)[^/]*(credential|service[-_]?account|firebase-adminsdk)[^/]*\.json$/i, why: "cloud credentials" },
  { re: /(^|\/)\.(npmrc|pypirc|netrc)$/i, why: "may hold a registry token" },
  { re: /(^|\/)\.aws\/credentials$/i, why: "AWS credentials" },
];

export interface SecretHit {
  path: string;
  why: string;
}

export function findSecretFiles(paths: string[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const path of paths) {
    if (SAFE_ENV.test(path) || /(^|\/)node_modules\//.test(path)) continue;
    const match = SECRET_PATTERNS.find((p) => p.re.test(path));
    if (match) hits.push({ path, why: match.why });
  }
  return hits;
}

export interface ReadmeReport {
  has_readme: boolean;
  missing: string[];
  empty: string[];
}

/** README text and lines are capped so a hostile README cannot make the check slow. */
export const README_MAX_CHARS = 200_000;
const LINE_MAX_CHARS = 2_000;
const PLACEHOLDER_WORDS = new Set(["todo", "tbd", "tba", "n/a", "-", "작성", "작성 예정", "미정", "(작성)"]);

/** Placeholder lines ("TODO", "작성 예정", "(여기에 입력)", "<링크>") do not count as content. Linear time. */
function isPlaceholder(line: string): boolean {
  const l = line.toLowerCase();
  if (PLACEHOLDER_WORDS.has(l)) return true;
  if (l.startsWith("(") && l.endsWith(")") && l.includes("입력")) return true;
  return l.startsWith("<") && l.endsWith(">");
}

/** "## 기술 스택 ##" -> { level: 2, text: "기술 스택" }. Linear time, no regex backtracking. */
function heading(line: string): { level: number; text: string } | null {
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  if (level === 0 || level > 6 || (line[level] !== " " && line[level] !== "\t")) return null;
  let text = line.slice(level).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  text = text.slice(0, end).trim();
  return { level, text: text.toLowerCase() };
}

/** Removes <!-- ... --> in one pass (an unclosed comment runs to the end). */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = text.indexOf("<!--", i);
    if (open === -1) return out + text.slice(i);
    out += text.slice(i, open);
    const close = text.indexOf("-->", open + 4);
    if (close === -1) return out;
    i = close + 3;
  }
}

/**
 * For each required section: is there a heading containing that text, and does it have content?
 * HTML comments and placeholder lines do not count as content.
 */
export function checkReadme(readme: string | null, required: string[]): ReadmeReport {
  if (!required.length) return { has_readme: readme !== null, missing: [], empty: [] };
  if (readme === null) return { has_readme: false, missing: [...required], empty: [] };

  const text = stripComments(readme.slice(0, README_MAX_CHARS));
  const lines = text.split(/\r?\n/).map((l) => (l.length > LINE_MAX_CHARS ? l.slice(0, LINE_MAX_CHARS) : l));
  const headings = lines.flatMap((line, i) => {
    const h = heading(line);
    return h ? [{ line: i, ...h }] : [];
  });

  const missing: string[] = [];
  const empty: string[] = [];
  for (const section of required) {
    const idx = headings.findIndex((h) => h.text.includes(section.toLowerCase()));
    if (idx === -1) {
      missing.push(section);
      continue;
    }
    const h = headings[idx]!;
    const next = headings.slice(idx + 1).find((n) => n.level <= h.level);
    const body = lines
      .slice(h.line + 1, next ? next.line : lines.length)
      .map((l) => l.trim().replace(/^([-*+]|\d+\.)\s*/, "").replace(/^>\s*/, "").trim())
      .filter((l) => l && !isPlaceholder(l) && !heading(l));
    if (body.length === 0) empty.push(section);
  }
  return { has_readme: true, missing, empty };
}
