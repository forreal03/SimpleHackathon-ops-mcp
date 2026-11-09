/**
 * GitHub has no API for reading pending app installation requests, but it emails org owners:
 *
 *   Subject: Request to install Vercel in 2026ENDPoinT
 *   From:    noreply@github.com
 *   Body:    ... @alice has requested the installation of Vercel at your organization 2026ENDPoinT.
 *            https://github.com/apps/vercel/installations/new/permissions?request_id=123&target_id=456
 *
 * Emails are untrusted input. Only fields matched by the strict patterns below are used;
 * nothing else in the message is acted on.
 */

export interface RawEmail {
  sender: string;
  subject: string;
  body: string;
  date?: string;
}

export interface InstallRequest {
  app_name: string;
  app_slug: string;
  requester: string;
  org: string;
  request_id: string;
  target_id: string;
  review_url: string;
  received_at: string;
}

export type ParseResult = { ok: true; request: InstallRequest } | { ok: false; subject: string; reasons: string[] };

const SENDER = "noreply@github.com";
const SUBJECT_RE = /^\s*Request to install (.+?) in ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\s*$/;
const BODY_RE =
  /@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\s+has\s+requested\s+the\s+installation\s+of\s+([\s\S]{1,100}?)\s+at\s+your\s+organization\s+([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/;
// The URL must start a token, so "https://evil.example/?u=https://github.com/apps/..." does not match.
const LINK_RE =
  /(?<![\w.:/?=&%#-])https:\/\/github\.com\/apps\/([a-z0-9][a-z0-9-]{0,99})\/installations\/new\/permissions\?request_id=(\d{1,15})&target_id=(\d{1,15})(?![\w&=%-])/g;

export function senderAddress(sender: string): string {
  const angle = sender.match(/<([^<>\s]+)>/);
  return (angle?.[1] ?? sender).trim().toLowerCase();
}

export function parseInstallRequestEmail(email: RawEmail): ParseResult {
  const reasons: string[] = [];
  const subject = email.subject ?? "";

  if (senderAddress(email.sender ?? "") !== SENDER) reasons.push(`sender is not ${SENDER}`);

  const s = subject.match(SUBJECT_RE);
  if (!s) reasons.push('subject is not "Request to install <app> in <org>"');

  const b = (email.body ?? "").match(BODY_RE);
  if (!b) reasons.push('body has no "@<user> has requested the installation of <app> at your organization <org>"');

  const links = [...(email.body ?? "").matchAll(LINK_RE)];
  const distinct = new Set(links.map((m) => m[0]));
  if (distinct.size === 0) reasons.push("no https://github.com/apps/<app>/installations/new/permissions link");
  if (distinct.size > 1) reasons.push("more than one installation link");

  if (s && b) {
    if (s[1]!.trim() !== b[2]!.replace(/\s+/g, " ").trim()) reasons.push("app name in subject and body differ");
    if (s[2]!.toLowerCase() !== b[3]!.toLowerCase()) reasons.push("organization in subject and body differ");
  }

  if (reasons.length || !s || !b || distinct.size !== 1) return { ok: false, subject, reasons };

  const link = links[0]!;
  return {
    ok: true,
    request: {
      app_name: s[1]!.trim(),
      app_slug: link[1]!,
      requester: b[1]!,
      org: s[2]!,
      request_id: link[2]!,
      target_id: link[3]!,
      review_url: link[0],
      received_at: email.date ? new Date(email.date).toISOString() : new Date().toISOString(),
    },
  };
}

/** Checks a parsed request against the org this event manages. */
export function verifyInstallRequest(req: InstallRequest, org: { login: string; id: number }): string[] {
  const reasons: string[] = [];
  if (req.org.toLowerCase() !== org.login.toLowerCase()) reasons.push(`for organization "${req.org}", not "${org.login}"`);
  if (req.target_id !== String(org.id)) reasons.push(`target_id ${req.target_id} is not the id of ${org.login} (${org.id})`);
  return reasons;
}
