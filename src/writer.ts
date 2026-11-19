import Groq from "groq-sdk";
import { z } from "zod";
import type { Candidate } from "./gmail.js";

// openai/gpt-oss-120b is Groq's flagship production model and supports strict structured outputs.
// Override with GROQ_MODEL if Groq retires it (see https://console.groq.com/docs/models).
export const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

let client: Groq | undefined;
const groq = () => (client ??= new Groq()); // reads GROQ_API_KEY

const FollowUp = z.object({
  should_follow_up: z.boolean(),
  reason: z.string(),
  body: z.string(),
});
export type FollowUpResult = z.infer<typeof FollowUp>;

// Strict mode needs every field required and additionalProperties: false.
const FOLLOW_UP_SCHEMA = {
  type: "object",
  properties: {
    should_follow_up: {
      type: "boolean",
      description: "false if a follow-up would be pushy, pointless, or the thread doesn't need one",
    },
    reason: { type: "string", description: "one short sentence explaining the decision" },
    body: {
      type: "string",
      description: "the plain-text follow-up email body, including sign-off. Empty if should_follow_up is false",
    },
  },
  required: ["should_follow_up", "reason", "body"],
  additionalProperties: false,
};

const RULES = `You write follow-ups to cold emails that got no reply. You write as the person described in the second brain, in their voice.

What makes a good follow-up:
- It adds something new: a fresh angle, a small piece of proof, a useful link or idea from the second brain, or a lower-friction ask. Never "just checking in", "bumping this", or "circling back".
- It stands alone. The reader may not have read the first email, so restate the point in one line.
- It's short: 2 to 5 sentences. Shorter than the original.
- One ask, easy to answer with a one-line reply.
- It reads like a real person typed it. Use contractions. No em dashes. No "I hope this finds you well". No "It's not X, it's Y" lines, no self-answered questions, no "Here's the thing".
- No subject line, no placeholders like [link] unless the link is missing from the second brain. Only reference facts, projects and links that appear in the second brain or the thread. Never invent results.
- If this is the last follow-up allowed, make it a polite, warm breakup email that closes the loop and leaves the door open.

Say should_follow_up = false when the thread isn't a cold outreach (newsletters, receipts, replies to my own notes, internal chats), when the last email already said goodbye, or when another email would be annoying.

Answer with JSON matching the schema.`;

export async function writeFollowUp(
  brain: string,
  c: Candidate,
  maxFollowUps: number,
): Promise<FollowUpResult | null> {
  const transcript = c.messages
    .map(
      (m) =>
        `<email from="${m.fromMe ? "ME" : escape(m.from)}" to="${escape(m.to)}" date="${m.date.toISOString().slice(0, 10)}">\n${m.body}\n</email>`,
    )
    .join("\n\n");

  const followUpNumber = c.followUpsSent + 1;
  const isLast = followUpNumber >= maxFollowUps;

  const completion = await groq().chat.completions.create({
    model: MODEL,
    reasoning_effort: "medium",
    max_completion_tokens: 8000,
    response_format: {
      type: "json_schema",
      json_schema: { name: "follow_up", strict: true, schema: FOLLOW_UP_SCHEMA },
    },
    messages: [
      { role: "system", content: `${RULES}\n\n<second_brain>\n${brain}\n</second_brain>` },
      {
        role: "user",
        content: `Subject: ${c.last.subject}
Days since my last email: ${c.daysSinceLast}
This would be follow-up #${followUpNumber} of at most ${maxFollowUps}.${isLast ? " This is the LAST one: write the breakup email." : ""}

<thread>
${transcript}
</thread>`,
      },
    ],
  });

  const choice = completion.choices[0];
  const text = choice?.message?.content;
  if (!text) {
    console.warn(`  skipped: empty answer from the model (finish_reason: ${choice?.finish_reason})`);
    return null;
  }
  try {
    return FollowUp.parse(JSON.parse(text));
  } catch {
    console.warn(`  skipped: the model's answer wasn't valid JSON (finish_reason: ${choice.finish_reason})`);
    return null;
  }
}

const escape = (s: string) => s.replace(/"/g, "'");
