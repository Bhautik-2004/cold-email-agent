import fs from "node:fs";
import path from "node:path";

/**
 * The "second brain" is a folder of markdown files about you: who you are,
 * what you offer, how you write. Every file is given to the model as context
 * so follow-ups sound like you and point at real things you've done.
 */
export function loadBrain(dir: string): string {
  if (!fs.existsSync(dir)) {
    throw new Error(`Second brain folder not found: ${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort(); // stable order keeps the prompt prefix identical between runs (consistent output)

  if (files.length === 0) {
    throw new Error(`No .md files in ${dir}. Add at least about-me.md.`);
  }

  return files
    .map((f) => {
      const body = fs.readFileSync(path.join(dir, f), "utf8").trim();
      return `<file name="${f}">\n${body}\n</file>`;
    })
    .join("\n\n");
}
