import fs from "node:fs";
import { parseArgs } from "node:util";
import Groq from "groq-sdk";
import { loadBrain } from "./brain.js";
import { createReplyDraft, findCandidates, getGmail, getMyAddress } from "./gmail.js";
import { MODEL, writeFollowUp } from "./writer.js";

const STATE_PATH = "state.json";

const DEFAULTS = {
  draft: "false", // without --draft: preview only, nothing touches Gmail
  days: "5", // wait this long after my last email
  lookback: "45", // ignore threads older than this
  "max-followups": "3",
  limit: "10", // threads per run
  brain: "brain",
} as const;
type OptName = keyof typeof DEFAULTS;

const { values: cli, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    draft: { type: "boolean" },
    days: { type: "string" },
    lookback: { type: "string" },
    "max-followups": { type: "string" },
    limit: { type: "string" },
    brain: { type: "string" },
  },
});

// PowerShell strips the `--` in `npm start -- --days 0`, so npm eats `--days` and only
// the bare `0` reaches us. Say so plainly instead of guessing which flag it belonged to.
if (positionals.length > 0) {
  console.error(
    `Got "${positionals.join(" ")}" without a flag name. In PowerShell, npm swallows flags after "--".\n` +
      `Run the script directly instead, e.g.:  npx tsx src/index.ts --days 0\n` +
      `(or quote the separator:  npm start '--' --days 0)`,
  );
  process.exit(1);
}

function opt(name: OptName): string {
  const value = cli[name];
  return value === undefined ? DEFAULTS[name] : String(value);
}

function num(name: OptName): number {
  const n = Number(opt(name));
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number, got "${opt(name)}"`);
  return n;
}

const args = {
  draft: opt("draft") === "true",
  brain: opt("brain"),
  lookback: num("lookback"),
  limit: num("limit"),
};
const days = num("days");
const maxFollowUps = num("max-followups");

// Remembers the last message we drafted against, so a deleted draft isn't rewritten every run.
type State = Record<string, string>;
const state: State = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : {};

// Fail before touching Gmail if the model can't be reached.
function checkGroqKey() {
  if (process.env.GROQ_API_KEY) return;
  console.error(
    "No Groq API key found.\n" +
      "Get one at https://console.groq.com/keys, then in this terminal run:\n" +
      '  PowerShell:  $env:GROQ_API_KEY = "gsk_..."\n' +
      "  bash:        export GROQ_API_KEY=gsk_...",
  );
  process.exit(1);
}

async function main() {
  checkGroqKey();
  const brain = loadBrain(args.brain!);
  const gmail = await getGmail();
  const me = await getMyAddress(gmail);
  console.log(`Signed in as ${me}. Looking for cold emails with no reply after ${days}+ days...\n`);

  const candidates = (
    await findCandidates(gmail, me, {
      days,
      lookbackDays: Number(args.lookback),
      maxFollowUps,
      limit: Number(args.limit),
    })
  ).filter((c) => state[c.threadId] !== c.last.id);

  if (candidates.length === 0) {
    console.log("Nothing to follow up on. Inbox zero, of the outbound kind.");
    return;
  }

  let drafted = 0;
  for (const c of candidates) {
    console.log(`— "${c.last.subject}" to ${c.last.to} (${c.daysSinceLast}d, follow-up #${c.followUpsSent + 1})`);
    const result = await writeFollowUp(brain, c, maxFollowUps);
    if (!result) continue;

    if (!result.should_follow_up) {
      console.log(`  skipped: ${result.reason}\n`);
      state[c.threadId] = c.last.id;
      continue;
    }

    console.log(indent(result.body));
    if (args.draft) {
      await createReplyDraft(gmail, c, result.body);
      state[c.threadId] = c.last.id;
      drafted++;
      console.log("  ✓ saved as a draft in this thread\n");
    } else {
      console.log("  (preview only; run with --draft to save it in Gmail)\n");
    }
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  if (args.draft) console.log(`Done. ${drafted} draft(s) waiting in Gmail. Review and hit send yourself.`);
}

const indent = (s: string) => s.split("\n").map((l) => `  | ${l}`).join("\n");

main().catch((err) => {
  if (err instanceof Groq.AuthenticationError) {
    console.error("Groq API key is invalid. Check GROQ_API_KEY (see README).");
  } else if (err instanceof Groq.RateLimitError) {
    console.error("Rate limited by Groq (free tier has per-minute limits). Wait a minute or use --limit 1.");
  } else if (err instanceof Groq.NotFoundError || err instanceof Groq.BadRequestError) {
    console.error(
      `Groq rejected the request: ${err.message}\n` +
        `If the model "${MODEL}" was retired, set GROQ_MODEL to a current one from https://console.groq.com/docs/models`,
    );
  } else if (err instanceof Groq.APIError) {
    console.error(`Groq API error ${err.status}: ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
