#!/usr/bin/env node
// Pull the profile repo, regenerate the combined heatmap, and push only the
// SVG when it changed. Designed for both launchd and safe manual runs.

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { generate } = require('./generate-heatmap');

const REPO_ROOT = path.resolve(__dirname, '..');
const HEATMAP_PATH = 'claude-code-heatmap.svg';
const LOCK_PATH = path.join(REPO_ROOT, '.heatmap-sync.lock');
const COMMIT_NAME = 'Carl723000';
const COMMIT_EMAIL = '74130028+Carl723000@users.noreply.github.com';

function gitExecutable() {
  if (process.env.CCU_GIT) return process.env.CCU_GIT;
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(options.environment || {}),
    },
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${path.basename(command)} ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function runGit(args, options = {}) {
  return runCommand(gitExecutable(), args, options);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(LOCK_PATH, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return async () => fsp.rm(LOCK_PATH, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let state = {};
      try {
        state = JSON.parse(await fsp.readFile(LOCK_PATH, 'utf8'));
      } catch {
        // Invalid lock state is treated as stale.
      }
      if (processIsAlive(Number(state.pid))) {
        throw new Error(`Another heatmap sync is already running (pid ${state.pid})`);
      }
      await fsp.rm(LOCK_PATH, { force: true });
    }
  }
  throw new Error('Could not acquire the heatmap sync lock');
}

function assertCleanWorkingTree() {
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim();
  if (status) {
    throw new Error('Profile repo has uncommitted files; sync stopped so it cannot commit unrelated work');
  }
}

function assertExpectedRepo() {
  const root = runGit(['rev-parse', '--show-toplevel']).stdout.trim();
  if (fs.realpathSync(root) !== fs.realpathSync(REPO_ROOT)) {
    throw new Error(`Unexpected Git repository root: ${root}`);
  }
}

async function syncProfile(options = {}) {
  const releaseLock = await acquireLock();
  try {
    assertExpectedRepo();
    assertCleanWorkingTree();
    console.log(`[${new Date().toISOString()}] Weekly heatmap sync started`);

    if (!options.skipNetwork) {
      runGit(['pull', '--quiet', '--rebase']);
    }
    const result = await generate({ repoRoot: REPO_ROOT });
    for (const warning of result.warnings) console.warn(`Warning: ${warning}`);

    const changed = runGit(['diff', '--quiet', '--', HEATMAP_PATH], { allowFailure: true });
    if (changed.status !== 0 && changed.status !== 1) {
      throw new Error(`Could not inspect ${HEATMAP_PATH}`);
    }
    if (changed.status === 1) {
      runGit(['add', '--', HEATMAP_PATH]);
      runGit([
        '-c', `user.name=${COMMIT_NAME}`,
        '-c', `user.email=${COMMIT_EMAIL}`,
        'commit', '--quiet', '-m', 'chore: weekly Claude + Codex heatmap refresh',
        '--', HEATMAP_PATH,
      ]);
      console.log('Committed the refreshed combined heatmap');
    } else {
      console.log('Heatmap content is unchanged');
    }

    if (!options.skipNetwork) {
      runGit(['push', '--quiet']);
      console.log('GitHub profile is up to date');
    }
    console.log(`[${new Date().toISOString()}] Weekly heatmap sync completed`);
    return { changed: changed.status === 1, generation: result };
  } finally {
    await releaseLock();
  }
}

if (require.main === module) {
  syncProfile().catch((error) => {
    console.error(`[${new Date().toISOString()}] Weekly heatmap sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { acquireLock, gitExecutable, syncProfile };
