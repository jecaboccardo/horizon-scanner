# Claude Code configuration

This directory configures [Claude Code](https://claude.ai/code) for this project.
It gives Claude persistent context about the codebase so you don't have to re-explain it each session.

## Structure

```
.claude/
├── agents/          Subagent definitions — specialized modes Claude can be invoked in
├── rules/           Context injected automatically into every Claude Code session
├── skills/          Slash commands: type /skill-name to invoke
└── settings.json    Project-level Claude Code settings (allowlists, env vars)
```

## Agents

Invoke via the Agent tool or by asking Claude to act as a specific agent.

| Agent | When to use |
|-------|-------------|
| `corpus-backfill` | Filling metadata gaps (abstracts, SMS, geography, embeddings) safely |
| `denylist-curation` | Flagging non-research noise rows from the corpus |
| `eval-before-ship` | Running retrieval quality gates before shipping weight/channel changes |

## Skills (slash commands)

Type the command in the Claude Code prompt.

| Command | What it does |
|---------|-------------|
| `/apply-migration` | Applies a `supabase/migrations/*.sql` file to the Postgres DB |
| `/corpus-gap-count` | Reports live null-abstract / SMS / geography / embedding gap counts |
| `/deploy-with-jel-drain` | Safe deploy checklist — waits for in-flight JEL papers before restarting |
| `/run-horizon-scanner` | Starts the app locally and smoke-tests it |

## Rules

Loaded automatically. Cover the API contracts, architecture, AI gateway config, and data model.
Claude references these without you having to re-paste them each session.

## Settings

`settings.json` — project-level permissions and allowed commands.
`settings.local.json` — your personal overrides (gitignored — never commit this).
