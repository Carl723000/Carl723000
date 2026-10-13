# Local twice-weekly profile heatmaps

The profile keeps its combined token heatmap and adds a compact API-equivalent
image, with separate Claude Code and Codex fee rows. Both images use the same
local calendar, six-step palette and trailing 366-day range. Prices are shown
as integers; source amounts retain full precision. `+` marks partial pricing.

## Schedule and switch

The existing per-user macOS LaunchAgent remains **Monday and Friday, 11:00 in
the machine's local timezone**. The on/off menu and commands are unchanged:

```sh
node scripts/sync-control.js on
node scripts/sync-control.js off
node scripts/sync-control.js status
node scripts/sync-control.js run
node scripts/sync-control.js schedule Mon,Fri 11:00
```

Local configuration is in the ignored `.heatmap-sync.json`; a portable example
is `sync-config.example.json`. `heatmapPalette` accepts the extension's existing
`academicViolet`, `claudeOrange`, `codexBlue`, `githubGreen`, and `custom`; the
custom accent is `heatmapAccent`.

## Aggregate producer prerequisite

Paired publication requires a fresh, exact Claude numeric checkpoint. An old
token SVG is not adequate: it contains rounded daily tokens and no precise fee
inputs. The installed extension 2.4.2 does **not** provide an unattended Claude
checkpoint producer. That narrow, opt-in local export is being implemented in
the 2.4.4 worktree; it is not yet installed or a completed native acceptance.

Set `profileCapture` (or `CCU_PROFILE_CAPTURE`) to its explicitly enabled local
path. The one atomic file wraps `{schemaVersion:1,claude,codex}`; each nested
payload retains its provider-specific numeric contract. The Claude payload is
schema 1, provider `claude`, currency `USD`,
and carries the resolved `timeZone`, current `asOfDay`, producer `generatedAt`,
`sourceComplete`, data/pricing revisions, pricing backend, and at most 366
whitelisted daily numeric DTOs. See `profile-heatmap-data.js` and its synthetic
tests for the exact contract. Do not manufacture the checkpoint from logs or
copy an old file with a new timestamp.

Until the supported producer is available and emits a complete, current-day
observation within 12 hours, paired sync stops before changing either image.
It does not re-label the 2026-08-27 Claude SVG as current. This intentional gate
also applies while the producer/index is rebuilding or a timezone is changing.

Codex uses the same numeric schema with provider `codex`, estimated=false, and
`currentManifestVerified=true` instead of `claudeBackend`. Both payloads must carry
the same producer `generatedAt`, local zone and observation day. Copying or
touching a raw index is not freshness evidence. The producer must use verified
local-day sidecars, not the UTC legacy `byDay`, without an extra scan. Unknown
prices remain unpriced, and cached input/reasoning are not double-counted.

## Publication

`generate-profile-heatmaps.js` validates both inputs and renders both images
before touching their public paths. Local replacement exceptions restore the
old pair. `sync-profile.js` requires a clean repo and one local lock; it stages
only `claude-code-heatmap.svg` and `api-equivalent-heatmap.svg`, reviews the staged
scope, and publishes them in a single Git commit. Failed quality checks or a
render failure publish neither. The first README/image-pair rollout must stay
local until the new Claude prerequisite is satisfied.

```sh
node --test scripts/*.test.js
node scripts/generate-profile-heatmaps.js
```

The old single-token `generate-heatmap.js` remains a legacy manual utility, not
the paired publication entry point. Its optional raw-log mode is not used by
the profile schedule or the new paired generator.
