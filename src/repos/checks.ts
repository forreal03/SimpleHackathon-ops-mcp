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

const PLACEHOLDER = /^(todo|tbd|tba|n\/a|-|작성|작성 예정|미정|\(작성\)|\(.*입력.*\)|<.*>)$/i;

/**
 * For each required section: is there a heading containing that text, and does it have content?
 * HTML comments and placeholder lines ("TODO", "작성 예정", "-") do not count as content.
 */
export function checkReadme(readme: string | null, required: string[]): ReadmeReport {
  if (!required.length) return { has_readme: readme !== null, missing: [], empty: [] };
  if (readme === null) return { has_readme: false, missing: [...required], empty: [] };

  const lines = readme.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const headings = lines
    .map((line, i) => ({ i, m: line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/) }))
    .filter((h): h is { i: number; m: RegExpMatchArray } => !!h.m)
    .map((h) => ({ line: h.i, level: h.m[1]!.length, text: h.m[2]!.toLowerCase() }));

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
      .map((l) => l.replace(/^\s*([-*+]|\d+\.)\s*/, "").replace(/^>\s*/, "").trim())
      .filter((l) => l && !PLACEHOLDER.test(l) && !/^#{1,6}\s/.test(l));
    if (body.length === 0) empty.push(section);
  }
  return { has_readme: true, missing, empty };
}
