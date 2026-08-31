# Local twice-weekly heatmap sync

This profile image combines the trailing-year token activity from **Claude
Code + Codex**. Generation and scheduling happen on the local machine because
the source logs are not available to a cloud GitHub Action.

## macOS switch

Double-click `热力图每周同步.command` in the repo root for a small Chinese menu,
or run:

```sh
node scripts/sync-control.js on
node scripts/sync-control.js off
node scripts/sync-control.js status
node scripts/sync-control.js run
node scripts/sync-control.js schedule Mon,Fri 20:00
```

The default is **Monday and Friday at 11:00, local machine time**. The per-user LaunchAgent is
stored at `~/Library/LaunchAgents/com.carl723000.ai-token-heatmap-weekly.plist`.
Turning the switch off unloads and disables the job but keeps the plist, so the
operation is reversible. A missed calendar run is coalesced by macOS and runs
after the computer next wakes.

Local schedule settings live in `.heatmap-sync.json`, which is ignored by Git.
The example is `scripts/sync-config.example.json`.

## Counting contract

- **Plugin snapshot mode:** pass `--claude-snapshot <SVG>` (or set
  `CCU_CLAUDE_HEATMAP_SVG`) to consume the aggregate heatmap exported by the
  VS Code extension. This mode does not reopen Claude transcripts.
- **Claude Code:** scan local `~/.claude/projects/**/*.jsonl`; count input,
  output, cache-write, and cache-read tokens. Records sharing the same
  message/request identity are reconciled by keeping the larger record, which
  matches the ClaudeCodeUsage loader and avoids placeholder/stream duplicates.
- **Codex:** by default read daily aggregates from the local ClaudeCodeUsage
  Codex index. CodexBar is available only when selected explicitly. In either
  case, `inputTotal + outputTotal` is counted; cached input is already inside
  input, and reasoning output is already inside output, so neither is added
  twice.
- **Multiple Codex indexes:** on overlapping dates the newer local aggregate
  owns its coverage window; an older index can fill earlier history.
- **Timezone:** days use the machine's local calendar timezone by default. Set
  `timeZone` to `local` in the ignored config (or omit it) to keep that behavior;
  an explicit IANA timezone or `CCU_HEATMAP_TZ` can be used for reproducible runs.

Only per-day totals are written into `claude-code-heatmap.svg`. Prompts,
responses, model names, project paths, session ids, and account data are never
published.

## Safe Git behavior

`scripts/sync-profile.js` refuses to run when this profile repo has unrelated
uncommitted files. It pulls with rebase, stages only
`claude-code-heatmap.svg`, commits only when that file changed, and pushes via
the repo's existing Git credentials. A local lock prevents overlapping manual
and scheduled runs.

## Verification

```sh
node --test scripts/*.test.js
node scripts/generate-heatmap.js --output /tmp/combined-heatmap.svg --json
```
