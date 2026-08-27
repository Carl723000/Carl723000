@echo off
REM Backward-compatible Windows entrypoint. The cross-platform Node runner
REM pulls, generates the combined Claude + Codex heatmap, commits only the SVG,
REM and pushes it if needed.
node "%~dp0sync-profile.js"
