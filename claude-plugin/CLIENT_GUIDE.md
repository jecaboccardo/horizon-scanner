# Writing survey papers in Claude Code — a quick guide

This lets you generate full IADB-grade survey papers **from your own Claude Code
terminal, using your own Claude subscription**. You ask a question, the Horizon
Scanner corpus supplies the evidence, and your Claude writes the paper.

You only set this up **once**. After that, it's a single command per paper.

---

## Before you start (one time)

You need two things:

1. **Claude Code** installed on your computer. Download it from
   **claude.com/claude-code** and sign in with your Claude account.
2. **A Claude paid plan** (Pro or Max). The paper is written by *your* Claude, so
   the usage is covered by your own subscription.

> Don't have Claude Code or a paid plan? You can still generate papers the normal
> way inside the Horizon Scanner web app — this terminal option is just an
> alternative for people who prefer Claude Code.

---

## Step 1 — Get your setup snippet from the web app (one time)

1. Open **Horizon Scanner** in your browser and sign in.
2. Click your **account** (top-right) → **"Set up Claude Code"**.
3. Click **"Copy setup"**. This copies three short lines, including a personal key.

> Keep that key private — it's tied to your account. You can revoke it anytime from
> the same account menu, and create a new one.

## Step 2 — Paste it into Claude Code (one time)

Open Claude Code and run the copied lines **one at a time, in order** (paste a line,
press Enter, then the next):

1. `/plugin marketplace add …`  → registers the Horizon Scanner plugin
2. `/plugin install horizon-scanner@horizon-scanner`  → installs it
3. `/reload-plugins`  → **activates** the new commands (required before the next line)
4. `/horizon-scanner:horizon-login hsk_…`  → saves your key (you won't have to do this again)

> ⚠️ Order matters: `/horizon-scanner:horizon-login` only works **after** `/reload-plugins` — that's
> why it's line 4. If `/horizon-scanner:horizon-login` or `/horizon-scanner:horizon` says "not recognized," run
> `/reload-plugins` and try again.

You'll see **"Saved. You can now run /horizon-scanner:horizon."** Setup is done — you never
repeat Steps 1–2.

---

## Writing a paper (every time)

In Claude Code, type:

```
/horizon-scanner:horizon your research question
```

For example:
```
/horizon-scanner:horizon returns to schooling from information interventions in Latin America
```

Claude narrates each step as it goes (you'll see a `▶` line before each), so you always
know what's happening.

### What you'll see
1. **A few clarifying questions, one at a time** — like the web app: region, population focus,
   evidence type (causal/foundational), recency, which sources to prioritize, and paper length.
   Each is asked in turn with a sensible default — reply **"defaults"** at any point to accept that
   one and all the rest, or adjust a few. (Add `--no-clarify` to skip and use defaults.)
2. **Searching the corpus** — Claude retrieves the most relevant papers with your filters and
   lists them.
3. **Suggested additions** — Claude proposes important/seminal papers that might be missing;
   each is verified against the real corpus (nothing is invented).
4. **Your review (one round)** — Claude shows the full evidence table (base + suggestions) and you
   can, in one reply: **remove** papers (by number), ask Claude to **find a specific paper in the
   corpus** (name it by title/author — it's verified against the real corpus), or **upload your own**
   paper that isn't in the corpus (paste a DOI or citation — flagged "unverified"). Claude then shows
   the final set before writing.
5. **Tiering & deepening** — Claude tiers the evidence (Core / Context / Off, like the web app) and, for
   the Core papers, looks up effect sizes the abstracts leave out (verified against each paper by name).
6. **Writing** — the paper is drafted in front of you, section by section, with citations.
7. **What was used** — at the end Claude shows **only the papers actually cited** and explains
   how they were selected (relevance + credibility), rather than the whole pool.
8. **Saved** — you get the paper as **Word** (`horizon-paper-….docx`) and the **full evidence table**
   as **Excel** (`horizon-paper-…-evidence.xlsx`, one row per paper with Cited + Tier columns + abstracts),
   plus a `.md` source copy. The paper itself ends with a **Works Cited** list of just the papers used.

Open the Word file to read or share it. You can also upload it back into the Horizon Scanner Library.

---

## Good to know

- **Everything stays grounded in the evidence.** Claude can only cite papers that
  are actually in the Horizon Scanner corpus — it won't fabricate studies or
  findings.
- **You're in control of the evidence.** The review step (4 above) lets you keep or
  drop the suggested additions before the paper is written.
- **Cost.** Generating the paper uses your own Claude subscription — it isn't billed
  to Horizon Scanner.
- **Two ways to start a paper:**
  - From a question, as above: `/horizon-scanner:horizon …`.
  - From a table you already curated in the web app's Paper Studio: use the plan id
    with `/horizon-scanner:horizon --plan <id>`.

---

## Staying up to date

- **Where the plugin lives:** https://github.com/jecaboccardo/horizon-scanner-plugin
- **What's new:** the [CHANGELOG](https://github.com/jecaboccardo/horizon-scanner-plugin/blob/main/CHANGELOG.md)
  lists every version's changes.
- **Your installed version:** run `/plugin` in Claude Code — it shows the version you have.
  Claude Code flags "update available" when a newer version is published.
- **To update** (occasionally, or when you see an update is available):
  ```
  /plugin marketplace update horizon-scanner
  /plugin update horizon-scanner
  /reload-plugins
  ```
- You **don't** need to update for evidence-quality or writing improvements — those come from
  the Horizon Scanner service and apply automatically. Updates only matter for changes to the
  plugin's own commands (e.g. new questions, new export formats).

The same version + changelog link is shown in the app's **"Set up Claude Code"** panel.

---

## If something goes wrong

| You see | What to do |
|---|---|
| *"run /horizon-scanner:horizon-login first"* | You skipped Step 2 — run `/horizon-scanner:horizon-login <your key>` (copy it again from the app's "Set up Claude Code"). |
| A **401 / unauthorized** error | Your key was revoked or replaced — get a fresh one from the app and run `/horizon-scanner:horizon-login` again. |
| `/horizon-scanner:horizon` isn't recognized | The plugin didn't install — re-run the two `/plugin …` lines from Step 2. |
| It seems stuck | Large papers take a few minutes (the corpus search and drafting are real work). Give it time; if it errors, just run the command again. |

Need help? Contact your Horizon Scanner administrator.
