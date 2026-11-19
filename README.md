# cold-email-agent

Finds cold emails you sent that got no reply, and drafts a follow-up in the same Gmail thread. It uses an LLM on Groq and a "second brain" (a folder of markdown notes about you), so each follow-up sounds like you and adds something new instead of "just checking in".

**It never sends.** It only creates drafts. You read each one and hit send yourself.

## How it works

1. Searches your Sent folder for threads where you wrote last, 5+ days ago, and nobody replied.
2. Skips threads that already have a draft, and threads where you've already sent 3 follow-ups.
3. Sends the thread and your `brain/` notes to the model (default `openai/gpt-oss-120b` on Groq), which decides whether a follow-up makes sense and writes it. The last allowed follow-up is a polite breakup email.
4. With `--draft`, saves each follow-up as a reply draft in the thread.

## Setup (about 10 minutes)

**1. Install**

```bash
npm install
```

**2. Groq API key**: get one (free) at https://console.groq.com/keys and set it:

```bash
# PowerShell (this window only; use setx GROQ_API_KEY "gsk_..." to make it permanent)
$env:GROQ_API_KEY = "gsk_..."
# bash
export GROQ_API_KEY=gsk_...
```

Optional: set `GROQ_MODEL` to use a different Groq model.

**3. Gmail access**

1. Go to https://console.cloud.google.com, create a project, and enable the **Gmail API**.
2. Under *Google Auth Platform*, set up the OAuth consent screen (External, testing mode) and add your own Gmail address as a test user.
3. Under *Clients*, create an OAuth client of type **Desktop app** and download the JSON.
4. Save it in this folder as `credentials.json`.

The first run opens a browser to sign in. Your login is saved to `token.json`. Both files are in `.gitignore`. Never commit them.

**4. Fill in your second brain**: edit the files in `brain/`. Any `.md` file in that folder gets used.

## Run

```bash
npm start              # preview: prints the follow-ups it would write, touches nothing
npm run draft          # saves them as Gmail drafts
npm run test-run       # preview with no waiting period, 3 threads max (for testing)
```

To pass options, run the script directly. This works the same in PowerShell and bash:

```bash
npx tsx src/index.ts --days 7
npx tsx src/index.ts --days 0 --draft
```

(`npm start -- --days 7` works in bash, but PowerShell strips the `--` and npm swallows the flag. In PowerShell write `npm start '--' --days 7` if you prefer npm.)

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--days` | 5 | Wait this many days after your last email |
| `--lookback` | 45 | Ignore threads older than this |
| `--max-followups` | 3 | Stop after this many follow-ups per thread |
| `--limit` | 10 | Max threads per run |
| `--brain` | brain | Folder with your notes |

## Cost

Each thread is one Groq call. The free tier is enough for daily runs; if you hit its per-minute limit, use `--limit` to process fewer threads per run.
