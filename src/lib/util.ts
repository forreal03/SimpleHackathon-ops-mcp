import { createHash, randomBytes, randomInt } from "node:crypto";

export const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** "alice@example.com" -> "al***@example.com". Used everywhere an email would leave the server. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

export function normEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/**
 * Accepts "alice", "@alice", "https://github.com/alice", "github.com/alice/" and returns "alice".
 * Returns "" when nothing usable is there, and null when something is there but it is not a valid login.
 */
export function normLogin(value: unknown): string | null {
  let s = String(value ?? "").trim();
  if (!s) return "";
  s = s.replace(/^@/, "");
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)/i);
  if (url?.[1]) s = url[1];
  s = s.replace(/\/+$/, "");
  return LOGIN_RE.test(s) ? s : null;
}

export function isValidLogin(login: string): boolean {
  return LOGIN_RE.test(login);
}

/** "Team 1" / "1" / "01" -> "01" with pad 2. Non-numeric values are kept as-is (trimmed). */
export function normTeamNo(value: unknown, pad: number): string {
  const s = String(value ?? "").trim();
  const digits = s.match(/\d+/)?.[0];
  if (!digits) return s;
  return digits.replace(/^0+(?=\d)/, "").padStart(pad, "0");
}

/** Replaces {key} placeholders. Unknown keys become "". */
export function fill(pattern: string, vars: Record<string, string | number | undefined>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}

/** Builds a RegExp that matches names produced by `pattern` (used to find managed teams/repos). */
export function patternToRegExp(pattern: string): RegExp {
  const parts = pattern.split(/(\{\w+\})/);
  const body = parts
    .map((p) => {
      if (p === "{team_no}") return "\\d+";
      if (/^\{\w+\}$/.test(p)) return "[A-Za-z0-9._-]*";
      return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${body}$`, "i");
}

/** JSON.stringify with sorted keys, so equal objects hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export function newConfirmCode(prefix: string): string {
  return `${prefix.toUpperCase()}-${randomInt(1000, 10000)}`;
}

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
