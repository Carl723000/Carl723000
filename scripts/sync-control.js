#!/usr/bin/env node
// Install and control the per-user macOS launchd job for the twice-weekly profile
// heatmap. No administrator privileges are required when run normally.

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');

const LABEL = 'com.carl723000.ai-token-heatmap-weekly';
const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, '.heatmap-sync.json');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', `${LABEL}.log`);
const ERROR_LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', `${LABEL}.error.log`);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_CONFIG = Object.freeze({
  // launchd and the generator both interpret "local" using the machine's
  // current calendar timezone. Keeping this symbolic makes the profile move
  // with the computer instead of baking in a city name.
  timeZone: 'local',
  codexSource: 'ccu-index',
  weekdays: [1, 5],
  hour: 11,
  minute: 0,
});

function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function resolveTimeZone(value = 'local') {
  const timeZone = value === 'local' || value === undefined || value === null
    ? systemTimeZone()
    : String(value).trim();
  if (!timeZone) throw new Error('timeZone must be a non-empty IANA timezone or local');
  // Let Intl validate the IANA timezone name.
  new Intl.DateTimeFormat('en', { timeZone }).format(new Date());
  return timeZone;
}

function displayTimeZone(value) {
  return value === 'local' ? `local (${systemTimeZone()})` : value;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeConfig(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const config = { ...DEFAULT_CONFIG, ...input };
  const rawWeekdays = input.weekdays !== undefined
    ? input.weekdays
    : input.weekday !== undefined
      ? [input.weekday]
      : DEFAULT_CONFIG.weekdays;
  config.weekdays = weekdayNumbers(rawWeekdays);
  delete config.weekday;
  for (const [key, minimum, maximum] of [
    ['hour', 0, 23],
    ['minute', 0, 59],
  ]) {
    if (!Number.isInteger(config[key]) || config[key] < minimum || config[key] > maximum) {
      throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
    }
  }
  if (typeof config.timeZone !== 'string' || !config.timeZone.trim()) {
    throw new Error('timeZone must be a non-empty IANA timezone or local');
  }
  resolveTimeZone(config.timeZone);
  if (!['auto', 'ccu-index', 'codexbar'].includes(config.codexSource)) {
    throw new Error('codexSource must be auto, ccu-index, or codexbar');
  }
  if (
    config.claudeSnapshot !== undefined
    && (typeof config.claudeSnapshot !== 'string' || !config.claudeSnapshot.trim())
  ) {
    throw new Error('claudeSnapshot must be a non-empty path when provided');
  }
  return config;
}

function readConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_CONFIG };
    throw new Error(`Could not read ${CONFIG_PATH}: ${error.message}`);
  }
}

async function writeConfig(config) {
  const normalized = normalizeConfig(config);
  const temporary = `${CONFIG_PATH}.tmp-${process.pid}`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temporary, CONFIG_PATH);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  return normalized;
}

function nodeExecutable() {
  const stableUserNode = path.join(os.homedir(), '.local', 'bin', 'node');
  return fs.existsSync(stableUserNode) ? stableUserNode : process.execPath;
}

function renderPlist(config, options = {}) {
  const normalized = normalizeConfig(config);
  const nodePath = options.nodePath || nodeExecutable();
  const syncScript = options.syncScript || path.join(REPO_ROOT, 'scripts', 'sync-profile.js');
  const repoRoot = options.repoRoot || REPO_ROOT;
  const logPath = options.logPath || LOG_PATH;
  const errorLogPath = options.errorLogPath || ERROR_LOG_PATH;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(syncScript)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoRoot)}</string>
  <key>StartCalendarInterval</key>
  <array>
${normalized.weekdays.map((weekday) => `    <dict>
      <key>Weekday</key>
      <integer>${weekday}</integer>
      <key>Hour</key>
      <integer>${normalized.hour}</integer>
      <key>Minute</key>
      <integer>${normalized.minute}</integer>
    </dict>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errorLogPath)}</string>
</dict>
</plist>
`;
}

function launchctl(args, allowFailure = false) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`launchctl ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function serviceTarget() {
  return `gui/${process.getuid()}/${LABEL}`;
}

function serviceDomain() {
  return `gui/${process.getuid()}`;
}

function isEnabled() {
  return launchctl(['print', serviceTarget()], true).status === 0;
}

function scheduleLabel(config) {
  const normalized = normalizeConfig(config);
  const days = normalized.weekdays.map((weekday) => WEEKDAYS[weekday]).join(' + ');
  return `${days} ${String(normalized.hour).padStart(2, '0')}:${String(normalized.minute).padStart(2, '0')}`;
}

async function turnOn() {
  if (process.platform !== 'darwin') throw new Error('The automatic switch currently supports macOS launchd');
  const config = readConfig();
  await fsp.mkdir(path.dirname(PLIST_PATH), { recursive: true });
  await fsp.mkdir(path.dirname(LOG_PATH), { recursive: true });
  const temporary = `${PLIST_PATH}.tmp-${process.pid}`;
  try {
    await fsp.writeFile(temporary, renderPlist(config), { mode: 0o644 });
    await fsp.rename(temporary, PLIST_PATH);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  launchctl(['bootout', serviceTarget()], true);
  launchctl(['enable', serviceTarget()]);
  launchctl(['bootstrap', serviceDomain(), PLIST_PATH]);
  if (!isEnabled()) throw new Error('launchd accepted the job but it is not loaded');
  console.log(`Heatmap sync is ON (${scheduleLabel(config)}, ${displayTimeZone(config.timeZone)})`);
  console.log(`LaunchAgent: ${PLIST_PATH}`);
}

function turnOff() {
  if (process.platform !== 'darwin') throw new Error('The automatic switch currently supports macOS launchd');
  launchctl(['bootout', serviceTarget()], true);
  launchctl(['disable', serviceTarget()]);
  console.log('Heatmap sync is OFF. The plist is kept so it can be enabled again.');
}

function showStatus() {
  const config = readConfig();
  console.log(`Heatmap sync: ${isEnabled() ? 'ON' : 'OFF'}`);
  console.log(`Schedule: ${scheduleLabel(config)} (${displayTimeZone(config.timeZone)})`);
  console.log(`Claude source: ${config.claudeSnapshot || 'local fallback'}`);
  console.log(`Codex source: ${config.codexSource}`);
  console.log(`Log: ${LOG_PATH}`);
  console.log(`Errors: ${ERROR_LOG_PATH}`);
  return isEnabled();
}

function runNow() {
  const result = spawnSync(nodeExecutable(), [path.join(REPO_ROOT, 'scripts', 'sync-profile.js')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Manual sync exited with status ${result.status}`);
}

function weekdayNumber(value) {
  const normalized = String(value).trim().toLowerCase();
  if (/^[0-6]$/.test(normalized)) return Number(normalized);
  const index = WEEKDAYS.findIndex((day) => day.toLowerCase().startsWith(normalized));
  if (index < 0) throw new Error('Weekday must be 0-6 or Sun-Sat');
  return index;
}

function weekdayNumbers(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[,+\s]+/).filter(Boolean);
  if (values.length === 0) throw new Error('At least one weekday is required');
  return [...new Set(values.map((entry) => weekdayNumber(entry)))].sort((left, right) => left - right);
}

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match) throw new Error('Time must use HH:MM');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('Time is outside 00:00-23:59');
  return { hour, minute };
}

async function changeSchedule(weekdays, time) {
  const wasEnabled = isEnabled();
  const config = readConfig();
  const parsedTime = parseTime(time);
  const next = await writeConfig({
    ...config,
    weekdays: weekdayNumbers(weekdays),
    ...parsedTime,
  });
  if (wasEnabled) await turnOn();
  console.log(`Schedule saved: ${scheduleLabel(next)} (${displayTimeZone(next.timeZone)})`);
}

function recentLog(file, limit = 30) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    return lines.slice(-limit).join('\n');
  } catch (error) {
    return error.code === 'ENOENT' ? '(no log yet)' : `(could not read log: ${error.message})`;
  }
}

async function menu() {
  const interface_ = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nClaude Code + Codex 热力图每周两次同步');
    showStatus();
    console.log('\n1. 开启自动同步\n2. 关闭自动同步\n3. 立即同步一次\n4. 修改同步时间\n5. 查看最近日志\n0. 退出');
    const choice = (await interface_.question('\n请选择：')).trim();
    if (choice === '1') await turnOn();
    else if (choice === '2') turnOff();
    else if (choice === '3') runNow();
    else if (choice === '4') {
      const weekdays = await interface_.question('星期（可填 Mon,Fri 或 0,5）：');
      const time = await interface_.question('时间（HH:MM）：');
      await changeSchedule(weekdays, time);
    } else if (choice === '5') {
      console.log(`\n--- ${LOG_PATH} ---\n${recentLog(LOG_PATH)}`);
      console.log(`\n--- ${ERROR_LOG_PATH} ---\n${recentLog(ERROR_LOG_PATH)}`);
    }
  } finally {
    interface_.close();
  }
}

async function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  if (command === 'on' || command === 'enable' || command === 'install') await turnOn();
  else if (command === 'off' || command === 'disable') turnOff();
  else if (command === 'status') showStatus();
  else if (command === 'run') runNow();
  else if (command === 'schedule') await changeSchedule(args[0], args[1]);
  else if (command === 'menu') await menu();
  else if (command === 'help' || command === '--help' || command === '-h') {
    console.log('Usage: node scripts/sync-control.js on|off|status|run|schedule <Mon,Fri|0,5> <HH:MM>|menu');
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Heatmap sync control failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_CONFIG,
  LABEL,
  changeSchedule,
  normalizeConfig,
  parseTime,
  renderPlist,
  resolveTimeZone,
  scheduleLabel,
  systemTimeZone,
  weekdayNumber,
  weekdayNumbers,
};
