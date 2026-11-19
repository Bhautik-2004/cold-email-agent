import fs from "node:fs";
import { authenticate } from "@google-cloud/local-auth";
import { google, type gmail_v1 } from "googleapis";

// Read mail + create drafts. This tool never sends anything.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];
const CREDENTIALS_PATH = "credentials.json";
const TOKEN_PATH = "token.json";
const MAX_BODY_CHARS = 6000;

export type ThreadMessage = {
  id: string;
  from: string;
  to: string;
  cc: string;
  date: Date;
  subject: string;
  messageIdHeader: string;
  references: string;
  body: string;
  fromMe: boolean;
};

export type Candidate = {
  threadId: string;
  messages: ThreadMessage[];
  last: ThreadMessage;
  daysSinceLast: number;
  followUpsSent: number; // how many of my messages in a row at the end, minus the original
};

export async function getGmail(): Promise<gmail_v1.Gmail> {
  if (fs.existsSync(TOKEN_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    const auth = new google.auth.OAuth2(saved.client_id, saved.client_secret);
    auth.setCredentials({ refresh_token: saved.refresh_token });
    return google.gmail({ version: "v1", auth });
  }
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      "credentials.json not found. Create a Google OAuth 'Desktop app' client and save its JSON here (see README).",
    );
  }
  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
  const keys = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const key = keys.installed ?? keys.web;
  fs.writeFileSync(
    TOKEN_PATH,
    JSON.stringify({
      type: "authorized_user",
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    }),
  );
  return google.gmail({ version: "v1", auth: client as any });
}

export async function getMyAddress(gmail: gmail_v1.Gmail): Promise<string> {
  const { data } = await gmail.users.getProfile({ userId: "me" });
  return (data.emailAddress ?? "").toLowerCase();
}

/**
 * Threads where I sent the last message at least `days` ago and nobody has replied since.
 * Skips threads that already have a draft, and threads where I've already sent `maxFollowUps` follow-ups.
 */
export async function findCandidates(
  gmail: gmail_v1.Gmail,
  me: string,
  opts: { days: number; lookbackDays: number; maxFollowUps: number; limit: number },
): Promise<Candidate[]> {
  const q = [
    "in:sent",
    opts.days > 0 ? `older_than:${opts.days}d` : "", // --days 0 means "any age" (handy for testing)
    `newer_than:${opts.lookbackDays}d`,
  ]
    .filter(Boolean)
    .join(" ");
  const threadIds = new Set<string>();
  let pageToken: string | undefined;
  do {
    const { data } = await gmail.users.messages.list({ userId: "me", q, pageToken, maxResults: 100 });
    for (const m of data.messages ?? []) if (m.threadId) threadIds.add(m.threadId);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  const out: Candidate[] = [];
  for (const threadId of threadIds) {
    const { data: thread } = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const raw = thread.messages ?? [];
    if (raw.some((m) => m.labelIds?.includes("DRAFT"))) continue; // a draft already exists here

    const messages = raw.map((m) => toThreadMessage(m, me)).sort((a, b) => +a.date - +b.date);
    const last = messages.at(-1);
    if (!last || !last.fromMe) continue; // they replied (or someone else wrote last)

    const daysSinceLast = (Date.now() - +last.date) / 86_400_000;
    if (daysSinceLast < opts.days) continue;

    let mineAtEnd = 0;
    for (let i = messages.length - 1; i >= 0 && messages[i].fromMe; i--) mineAtEnd++;
    const followUpsSent = mineAtEnd - 1;
    if (followUpsSent >= opts.maxFollowUps) continue;

    // Skip notes-to-self: emails addressed only to my own inbox.
    if (!last.to || (last.to.toLowerCase().includes(me) && !last.cc)) continue;

    out.push({ threadId, messages, last, daysSinceLast: Math.floor(daysSinceLast), followUpsSent });
    if (out.length >= opts.limit) break;
  }
  return out;
}

export async function createReplyDraft(
  gmail: gmail_v1.Gmail,
  c: Candidate,
  body: string,
): Promise<string> {
  const subject = /^re:/i.test(c.last.subject) ? c.last.subject : `Re: ${c.last.subject}`;
  const references = [c.last.references, c.last.messageIdHeader].filter(Boolean).join(" ");
  const headers = [
    `To: ${c.last.to}`,
    c.last.cc ? `Cc: ${c.last.cc}` : "",
    `Subject: ${encodeHeader(subject)}`,
    c.last.messageIdHeader ? `In-Reply-To: ${c.last.messageIdHeader}` : "",
    references ? `References: ${references}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
  const { data } = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw, threadId: c.threadId } },
  });
  return data.id ?? "";
}

function toThreadMessage(m: gmail_v1.Schema$Message, me: string): ThreadMessage {
  const h = (name: string) =>
    m.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
  const from = h("From");
  let body = cleanBody(extractText(m.payload));
  if (body.length > MAX_BODY_CHARS) {
    console.warn(`  note: message ${m.id} is long; using its first ${MAX_BODY_CHARS} characters`);
    body = body.slice(0, MAX_BODY_CHARS);
  }
  return {
    id: m.id ?? "",
    from,
    to: h("To"),
    cc: h("Cc"),
    date: new Date(Number(m.internalDate ?? 0)),
    subject: h("Subject") || "(no subject)",
    messageIdHeader: h("Message-ID") || h("Message-Id"),
    references: h("References"),
    body,
    fromMe: from.toLowerCase().includes(me) || !!m.labelIds?.includes("SENT"),
  };
}

function extractText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
  for (const p of part.parts ?? []) {
    const t = extractText(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decode(part.body.data).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");
  }
  return "";
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

// Drop quoted history ("> ..." lines and everything after "On ... wrote:") so each message is just what was new.
function cleanBody(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim())) break;
    if (line.trim().startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
