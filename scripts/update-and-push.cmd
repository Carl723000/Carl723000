@echo off
REM Regenerate the Claude Code heatmap and push it if it changed.
REM Run daily by a local scheduled task (the Claude logs it reads are local,
REM so this can't run as a cloud GitHub Action). Safe to run manually any time.
setlocal
set "GIT=C:\Program Files\Git\cmd\git.exe"
set "NODE=C:\Program Files\nodejs\node.exe"
cd /d "%~dp0.."

"%GIT%" pull --quiet --rebase
"%NODE%" "%~dp0generate-heatmap.js"

REM git diff --quiet exits 1 when the SVG changed.
"%GIT%" diff --quiet -- claude-code-heatmap.svg
if errorlevel 1 (
  "%GIT%" add claude-code-heatmap.svg
  "%GIT%" -c user.name="Carl723000" -c user.email="wongkawing618@gmail.com" commit -m "chore: daily heatmap refresh"
  "%GIT%" push --quiet
  echo heatmap updated and pushed
) else (
  echo no change
)
endlocal
