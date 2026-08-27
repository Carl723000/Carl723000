#!/usr/bin/env node
// Generate the combined Claude Code + Codex token heatmap for this profile.
//
// Privacy boundary: only per-day aggregate token counts enter the SVG. Prompts,
// responses, project paths, model names, session ids, and account data never do.
//
// Claude Code is read directly from its local JSONL transcripts. Codex daily
// totals are read from local aggregate indexes already maintained by
// ClaudeCodeUsage and/or CodexBar. On overlapping days the newer aggregate
// source wins; an older source may fill earlier days outside the newer source's
// coverage window. This keeps the scheduled job fast even with very large
// Codex histories.

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_TIME_ZONE = 'Asia/Hong_Kong';
const COMBINED_SCALE = ['#ebedf0', '#e8def8', '#c9b4ed', '#9275d2', '#5b419d'];
const CLAUDE_COLOR = '#d97745';
const CODEX_COLOR = '#3578c8';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addDays(iso, amount) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function weekdayOf(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function daysBetween(left, right) {
  return Math.round(
    (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000,
  );
}

function compactNumber(value) {
  const absolute = Math.abs(value);
  const trim = (number) => number.toFixed(1).replace(/\.0$/, '');
  if (absolute >= 1e12) return `${trim(value / 1e12)}T`;
  if (absolute >= 1e9) return `${trim(value / 1e9)}B`;
  if (absolute >= 1e6) return `${trim(value / 1e6)}M`;
  if (absolute >= 1e3) return `${trim(value / 1e3)}K`;
  return String(Math.round(value));
}

function ordinal(day) {
  const lastTwo = day % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13
    ? 'th'
    : (['th', 'st', 'nd', 'rd'][Math.min(day % 10, 4)] || 'th');
  return `${day}${suffix}`;
}

function longDate(iso) {
  return `${MONTHS_FULL[Number(iso.slice(5, 7)) - 1]} ${ordinal(Number(iso.slice(8, 10)))}`;
}

function intensityBucket(value, maximum) {
  if (value <= 0 || maximum <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / maximum) * 4)));
}

function dayKeyInZone(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  });
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return year && month && day ? `${year}-${month}-${day}` : '';
}

function safeCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function addCount(daily, day, value) {
  if (!day || value <= 0) return;
  daily[day] = (daily[day] || 0) + value;
}

async function directoryExists(directory) {
  try {
    return (await fsp.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(file) {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function walkJsonlFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }
  if (await directoryExists(root)) await visit(root);
  return files.sort();
}

async function uniqueExistingDirectories(candidates) {
  const result = [];
  const seen = new Set();
  for (const candidate of candidates.filter(Boolean)) {
    if (!(await directoryExists(candidate))) continue;
    let identity = path.resolve(candidate);
    try {
      identity = await fsp.realpath(candidate);
    } catch {
      // The resolved path is still a safe fallback identity.
    }
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push(candidate);
    }
  }
  return result;
}

async function discoverClaudeRoots(environment = process.env, home = os.homedir()) {
  const explicit = (environment.CCU_CLAUDE_PROJECTS || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const configDirectory = environment.CLAUDE_CONFIG_DIR
    ? path.join(environment.CLAUDE_CONFIG_DIR, 'projects')
    : '';
  return uniqueExistingDirectories([
    ...explicit,
    configDirectory,
    path.join(home, '.claude', 'projects'),
    path.join(home, '.config', 'claude', 'projects'),
  ]);
}

function claudeTokenRecord(parsed, timeZone) {
  if (!parsed || typeof parsed !== 'object' || typeof parsed.timestamp !== 'string') return null;
  const message = parsed.message;
  const usage = message && typeof message === 'object' ? message.usage : null;
  if (!usage || typeof usage !== 'object') return null;
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  if (!message.model || message.model === '<synthetic>' || parsed.isApiErrorMessage) return null;
  const tokens = safeCount(usage.input_tokens)
    + safeCount(usage.output_tokens)
    + safeCount(usage.cache_creation_input_tokens)
    + safeCount(usage.cache_read_input_tokens);
  if (tokens <= 0) return null;
  const day = dayKeyInZone(new Date(parsed.timestamp), timeZone);
  if (!day) return null;
  const messageId = message.id;
  const requestId = parsed.requestId;
  const dedupKey = messageId || requestId
    ? `${String(messageId || 'no-msg')}-${String(requestId || 'no-req')}`
    : '';
  return { day, tokens, dedupKey };
}

async function collectClaudeDaily(options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const roots = options.roots || await discoverClaudeRoots(options.environment, options.home);
  const files = [];
  for (const root of roots) files.push(...await walkJsonlFiles(root));

  const daily = {};
  const deduplicated = new Map();
  const stats = {
    roots: roots.length,
    files: files.length,
    lines: 0,
    parseErrors: 0,
    acceptedWithoutId: 0,
    identifiedRecords: 0,
    duplicatesSkipped: 0,
    duplicatesReplaced: 0,
  };

  for (const file of files) {
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        stats.lines += 1;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          stats.parseErrors += 1;
          continue;
        }
        const record = claudeTokenRecord(parsed, timeZone);
        if (!record) continue;
        if (!record.dedupKey) {
          addCount(daily, record.day, record.tokens);
          stats.acceptedWithoutId += 1;
          continue;
        }
        const previous = deduplicated.get(record.dedupKey);
        if (!previous) {
          deduplicated.set(record.dedupKey, record);
          stats.identifiedRecords += 1;
        } else if (record.tokens > previous.tokens) {
          deduplicated.set(record.dedupKey, record);
          stats.duplicatesReplaced += 1;
        } else {
          stats.duplicatesSkipped += 1;
        }
      }
    } catch (error) {
      throw new Error(`Could not read Claude log ${file}: ${error.message}`);
    }
  }
  for (const record of deduplicated.values()) addCount(daily, record.day, record.tokens);
  return { daily, stats };
}

function stableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function codexTokenSignature(tokens = {}) {
  return [
    stableNumber(tokens.inputTotal),
    stableNumber(tokens.cachedInput),
    stableNumber(tokens.cacheWriteInput),
    stableNumber(tokens.outputTotal),
    stableNumber(tokens.reasoningOutput),
    stableNumber(tokens.sourceTotal),
  ];
}

function codexBucketSignature(buckets = {}) {
  return Object.entries(buckets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, tokens]) => [key, codexTokenSignature(tokens)]);
}

function codexContributionSignature(contribution) {
  const aggregate = contribution.aggregate || {};
  const session = aggregate.session || {};
  const structural = aggregate.structural || {};
  return JSON.stringify([
    codexTokenSignature(aggregate.total),
    codexBucketSignature(aggregate.byModel),
    codexBucketSignature(aggregate.byEffort),
    session.parentSessionKey ?? null,
    session.projectKey ?? null,
    session.role ?? null,
    stableNumber(session.startedAt),
    stableNumber(session.endedAt),
    stableNumber(structural.patchCalls),
    stableNumber(structural.toolCalls),
    stableNumber(structural.postPatchToolCalls),
    stableNumber(structural.compactCount),
    stableNumber(structural.taskCompleteCount),
  ]);
}

function canonicalCodexContributions(files = {}) {
  const canonicalKeys = new Set(Object.keys(files));
  const groups = new Map();
  for (const [recordKey, contribution] of Object.entries(files)) {
    const sessionKey = contribution?.aggregate?.session?.sessionKey;
    if (!sessionKey) continue;
    const group = groups.get(sessionKey) || [];
    group.push({ recordKey, contribution });
    groups.set(sessionKey, group);
  }

  let exactDuplicates = 0;
  let ambiguousGroups = 0;
  for (const group of groups.values()) {
    if (group.length === 1) continue;
    const active = group.filter(({ contribution }) => contribution.sourceArea === 'sessions');
    const archive = group.filter(({ contribution }) => contribution.sourceArea === 'archive');
    const verified = ({ contribution }) => (
      contribution.offset === contribution.size && !contribution.discardingOversizedLine
    );
    if (
      group.length === 2
      && active.length === 1
      && archive.length === 1
      && verified(active[0])
      && verified(archive[0])
      && codexContributionSignature(active[0].contribution)
        === codexContributionSignature(archive[0].contribution)
    ) {
      canonicalKeys.delete(archive[0].recordKey);
      exactDuplicates += 1;
    } else {
      ambiguousGroups += 1;
    }
  }
  return { canonicalKeys, exactDuplicates, ambiguousGroups };
}

function coverageOf(daily) {
  const activeDays = Object.keys(daily).filter((day) => daily[day] > 0).sort();
  return {
    firstDay: activeDays[0] || '',
    lastDay: activeDays[activeDays.length - 1] || '',
    activeDays: activeDays.length,
  };
}

async function loadCcuCodexIndexSource(indexPath, timeZone = DEFAULT_TIME_ZONE) {
  const stat = await fsp.stat(indexPath);
  const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  if (!index || typeof index !== 'object' || !index.files || typeof index.files !== 'object') {
    throw new Error(`Unsupported ClaudeCodeUsage Codex index: ${indexPath}`);
  }
  const { canonicalKeys, exactDuplicates, ambiguousGroups } = canonicalCodexContributions(index.files);
  const daily = {};
  let timezoneMismatches = 0;
  let canonicalFiles = 0;
  for (const key of canonicalKeys) {
    const contribution = index.files[key];
    const period = contribution?.aggregate?.period;
    if (!period || typeof period.days !== 'object') continue;
    if (period.timeZone && period.timeZone !== timeZone) {
      timezoneMismatches += 1;
      continue;
    }
    canonicalFiles += 1;
    for (const [day, slice] of Object.entries(period.days)) {
      const total = slice?.total || {};
      // Codex inputTotal already contains cached input; outputTotal already
      // contains reasoning output. Adding cached/reasoning again would double-count.
      addCount(daily, day, safeCount(total.inputTotal) + safeCount(total.outputTotal));
    }
  }
  if (Object.keys(daily).length === 0) {
    throw new Error(`ClaudeCodeUsage Codex index has no daily data in ${timeZone}`);
  }
  return {
    kind: 'ccu-index',
    label: 'ClaudeCodeUsage Codex index',
    path: indexPath,
    mtimeMs: stat.mtimeMs,
    daily,
    coverage: coverageOf(daily),
    details: { canonicalFiles, exactDuplicates, ambiguousGroups, timezoneMismatches },
  };
}

async function loadCodexBarSource(databasePath) {
  const stat = await fsp.stat(databasePath);
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('This Node.js build does not provide node:sqlite');
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let rows;
  try {
    rows = database.prepare(`
      SELECT day, SUM(input_tokens + output_tokens) AS tokens
      FROM day_aggregates
      WHERE day IS NOT NULL
      GROUP BY day
      ORDER BY day
    `).all();
  } finally {
    database.close();
  }
  const daily = {};
  for (const row of rows) addCount(daily, String(row.day), Number(row.tokens));
  if (Object.keys(daily).length === 0) {
    throw new Error(`CodexBar database has no daily Codex data: ${databasePath}`);
  }
  return {
    kind: 'codexbar',
    label: 'CodexBar daily aggregate database',
    path: databasePath,
    mtimeMs: stat.mtimeMs,
    daily,
    coverage: coverageOf(daily),
    details: { rows: rows.length },
  };
}

async function discoverCodexSources(options = {}) {
  const home = options.home || os.homedir();
  const environment = options.environment || process.env;
  const requested = options.codexSource || environment.CCU_CODEX_SOURCE || 'auto';
  if (!['auto', 'ccu-index', 'codexbar'].includes(requested)) {
    throw new Error(`Unknown Codex source: ${requested}`);
  }
  const indexCandidates = [
    environment.CCU_CODEX_INDEX,
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage',
      'growthjack.claude-code-usage', 'codex-index-v1.json'),
    path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage',
      'growthjack.claude-code-usage', 'codex-index-v1.json'),
    path.join(home, 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage',
      'growthjack.claude-code-usage', 'codex-index-v1.json'),
  ].filter(Boolean);
  const databaseCandidates = [
    environment.CCU_CODEXBAR_DB,
    path.join(home, 'Library', 'Caches', 'CodexBar', 'cost-usage', 'cost-usage.sqlite'),
  ].filter(Boolean);

  const sources = [];
  const errors = [];
  if (requested === 'auto' || requested === 'ccu-index') {
    for (const candidate of [...new Set(indexCandidates)]) {
      if (!(await fileExists(candidate))) continue;
      try {
        sources.push(await loadCcuCodexIndexSource(candidate, options.timeZone));
      } catch (error) {
        errors.push(`${candidate}: ${error.message}`);
      }
    }
  }
  if (requested === 'auto' || requested === 'codexbar') {
    for (const candidate of [...new Set(databaseCandidates)]) {
      if (!(await fileExists(candidate))) continue;
      try {
        sources.push(await loadCodexBarSource(candidate));
      } catch (error) {
        errors.push(`${candidate}: ${error.message}`);
      }
    }
  }
  if (sources.length === 0) {
    const suffix = errors.length > 0 ? ` (${errors.join('; ')})` : '';
    throw new Error(`No usable local Codex daily aggregate source was found${suffix}`);
  }
  return sources;
}

function mergeCodexSources(sources) {
  // Older source first, newer source last. The newer source owns its complete
  // coverage window, including zero days; older data only fills earlier gaps.
  const ordered = [...sources].sort((left, right) => (
    left.mtimeMs - right.mtimeMs || left.kind.localeCompare(right.kind)
  ));
  const daily = {};
  for (const source of ordered) {
    const { firstDay, lastDay } = source.coverage;
    if (!firstDay || !lastDay) continue;
    for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
      daily[day] = safeCount(source.daily[day]);
    }
  }
  return { daily, ordered, primary: ordered[ordered.length - 1] };
}

async function newestCodexLogMtime(home = os.homedir()) {
  const roots = [
    path.join(home, '.codex', 'sessions'),
    path.join(home, '.codex', 'archived_sessions'),
  ];
  let newest = 0;
  let files = 0;
  for (const root of roots) {
    for (const file of await walkJsonlFiles(root)) {
      files += 1;
      try {
        newest = Math.max(newest, (await fsp.stat(file)).mtimeMs);
      } catch {
        // A live session can rotate between discovery and stat; ignore it.
      }
    }
  }
  return { newest, files };
}

function combineDaily(claudeDaily, codexDaily) {
  const result = {};
  const days = new Set([...Object.keys(claudeDaily), ...Object.keys(codexDaily)]);
  for (const day of days) {
    const claude = safeCount(claudeDaily[day]);
    const codex = safeCount(codexDaily[day]);
    result[day] = { claude, codex, total: claude + codex };
  }
  return result;
}

function renderHeatmapSvg(daily, options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const weeks = Math.max(1, Math.min(53, options.weeks || 53));
  const today = options.endDateISO || dayKeyInZone(new Date(), timeZone);
  const scale = options.scale?.length === 5 ? options.scale : COMBINED_SCALE;
  const gridEndSaturday = addDays(today, 6 - weekdayOf(today));
  const startISO = addDays(gridEndSaturday, -(weeks * 7 - 1));
  const gridStart = addDays(startISO, -weekdayOf(startISO));
  const span = daysBetween(gridStart, today) + 1;
  const columns = Math.max(0, Math.ceil(span / 7));

  const cells = [];
  let maximum = 0;
  let total = 0;
  let claudeTotal = 0;
  let codexTotal = 0;
  for (let index = 0; index < span; index += 1) {
    const iso = addDays(gridStart, index);
    if (iso < startISO || iso > today) continue;
    const usage = daily[iso] || { claude: 0, codex: 0, total: 0 };
    const value = safeCount(usage.total);
    maximum = Math.max(maximum, value);
    total += value;
    claudeTotal += safeCount(usage.claude);
    codexTotal += safeCount(usage.codex);
    cells.push({
      iso,
      col: Math.floor(index / 7),
      row: index % 7,
      usage,
      value,
      bucket: 0,
    });
  }
  for (const cell of cells) cell.bucket = intensityBucket(cell.value, maximum);

  const cellSize = 12;
  const gap = 3;
  const step = cellSize + gap;
  const leftPadding = 38;
  const titleHeight = 24;
  const monthHeight = 18;
  const topPadding = titleHeight + monthHeight;
  const gridWidth = columns * step;
  const gridHeight = 7 * step;
  const footerHeight = 32;
  const width = leftPadding + gridWidth + 10;
  const height = topPadding + gridHeight + footerHeight;
  const year = Number(today.slice(0, 4));
  const title = options.title || `${compactNumber(total)} tokens in Claude Code + Codex · ${year}`;

  const output = [];
  output.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`);
  output.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  output.push(`<text x="${leftPadding}" y="16" font-size="15" font-weight="600" fill="#24292f">${escapeXml(title)}</text>`);

  for (const entry of cells) {
    const x = leftPadding + entry.col * step;
    const y = topPadding + entry.row * step;
    const tooltip = entry.value <= 0
      ? `No tokens on ${longDate(entry.iso)}`
      : `${compactNumber(entry.value)} tokens on ${longDate(entry.iso)} (Claude ${compactNumber(entry.usage.claude)} + Codex ${compactNumber(entry.usage.codex)})`;
    output.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" ry="2" fill="${scale[entry.bucket]}"><title>${escapeXml(tooltip)}</title></rect>`);
  }

  let lastMonth = -1;
  for (let column = 0; column < columns; column += 1) {
    const first = cells.find((entry) => entry.col === column);
    if (!first) continue;
    const month = Number(first.iso.slice(5, 7)) - 1;
    if (month !== lastMonth) {
      lastMonth = month;
      output.push(`<text x="${leftPadding + column * step}" y="${titleHeight + 13}" font-size="12" fill="#57606a">${MONTHS[month]}</text>`);
    }
  }
  for (const [row, label] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    output.push(`<text x="0" y="${topPadding + row * step + cellSize - 1}" font-size="11" fill="#57606a">${label}</text>`);
  }

  const footerY = topPadding + gridHeight + 19;
  output.push(`<rect x="${leftPadding}" y="${footerY - 8}" width="9" height="9" rx="2" fill="${CLAUDE_COLOR}"/>`);
  output.push(`<text x="${leftPadding + 13}" y="${footerY}" font-size="11" fill="#57606a">Claude ${compactNumber(claudeTotal)}</text>`);
  output.push(`<rect x="${leftPadding + 105}" y="${footerY - 8}" width="9" height="9" rx="2" fill="${CODEX_COLOR}"/>`);
  output.push(`<text x="${leftPadding + 118}" y="${footerY}" font-size="11" fill="#57606a">Codex ${compactNumber(codexTotal)}</text>`);

  let legendX = leftPadding + gridWidth - (5 * step + 56);
  output.push(`<text x="${legendX}" y="${footerY}" font-size="11" fill="#57606a">Less</text>`);
  legendX += 26;
  for (let bucket = 0; bucket < 5; bucket += 1) {
    output.push(`<rect x="${legendX + bucket * step}" y="${footerY - 9}" width="${cellSize}" height="${cellSize}" rx="2" fill="${scale[bucket]}"/>`);
  }
  output.push(`<text x="${legendX + 5 * step + 4}" y="${footerY}" font-size="11" fill="#57606a">More</text>`);
  output.push('</svg>');
  return {
    svg: output.join('\n'),
    summary: { total, claudeTotal, codexTotal, maximum, startISO, endISO: today },
  };
}

function readLocalConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.heatmap-sync.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Invalid local config ${configPath}: ${error.message}`);
  }
}

function parseArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') args.output = argv[++index];
    else if (argument === '--timezone') args.timeZone = argv[++index];
    else if (argument === '--codex-source') args.codexSource = argv[++index];
    else if (argument === '--end-date') args.endDateISO = argv[++index];
    else if (argument === '--json') args.json = true;
    else if (argument === '--help' || argument === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return args;
}

async function writeAtomic(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    await fsp.writeFile(temporary, contents, 'utf8');
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function generate(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const localConfig = options.localConfig || readLocalConfig(repoRoot);
  const timeZone = options.timeZone || localConfig.timeZone || process.env.CCU_HEATMAP_TZ || DEFAULT_TIME_ZONE;
  // Validate the timezone early instead of silently shifting dates.
  dayKeyInZone(new Date(), timeZone);
  const claude = await collectClaudeDaily({
    timeZone,
    roots: options.claudeRoots,
    environment: options.environment,
    home: options.home,
  });
  const codexSources = options.codexSources || await discoverCodexSources({
    timeZone,
    codexSource: options.codexSource || localConfig.codexSource,
    environment: options.environment,
    home: options.home,
  });
  const codex = mergeCodexSources(codexSources);
  const combined = combineDaily(claude.daily, codex.daily);
  const rendered = renderHeatmapSvg(combined, {
    timeZone,
    endDateISO: options.endDateISO,
  });
  const output = options.output || path.join(repoRoot, 'claude-code-heatmap.svg');
  await writeAtomic(output, rendered.svg);

  const logState = options.skipCodexLogFreshness
    ? { newest: 0, files: 0 }
    : await newestCodexLogMtime(options.home);
  const lagMs = logState.newest > 0 && codex.primary
    ? Math.max(0, logState.newest - codex.primary.mtimeMs)
    : 0;
  const warnings = [];
  if (lagMs > 30 * 60 * 1000) {
    warnings.push(`Codex aggregate source trails the newest local log by ${Math.round(lagMs / 60_000)} minutes`);
  }
  for (const source of codex.ordered) {
    if (source.details?.ambiguousGroups > 0) {
      warnings.push(`${source.label} retained ${source.details.ambiguousGroups} ambiguous session group(s) rather than guessing`);
    }
    if (source.details?.timezoneMismatches > 0) {
      warnings.push(`${source.label} skipped ${source.details.timezoneMismatches} file(s) indexed in another timezone`);
    }
  }
  return {
    output,
    timeZone,
    summary: rendered.summary,
    claudeStats: claude.stats,
    codexSources: codex.ordered.map((source) => ({
      kind: source.kind,
      label: source.label,
      mtime: new Date(source.mtimeMs).toISOString(),
      coverage: source.coverage,
      details: source.details,
    })),
    newestCodexLog: logState.newest ? new Date(logState.newest).toISOString() : null,
    warnings,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/generate-heatmap.js [--output FILE] [--timezone ZONE] [--codex-source auto|ccu-index|codexbar] [--end-date YYYY-MM-DD] [--json]');
    return;
  }
  const result = await generate(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Heatmap written: ${result.output}`);
  console.log(`Trailing-year tokens: ${compactNumber(result.summary.total)} (Claude ${compactNumber(result.summary.claudeTotal)} + Codex ${compactNumber(result.summary.codexTotal)})`);
  console.log(`Claude scan: ${result.claudeStats.files} files, ${result.claudeStats.lines} lines, ${result.claudeStats.duplicatesSkipped + result.claudeStats.duplicatesReplaced} duplicate records reconciled`);
  console.log(`Codex sources: ${result.codexSources.map((source) => `${source.kind} ${source.coverage.firstDay}…${source.coverage.lastDay}`).join('; ')}`);
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Heatmap generation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  addDays,
  canonicalCodexContributions,
  claudeTokenRecord,
  collectClaudeDaily,
  combineDaily,
  dayKeyInZone,
  discoverCodexSources,
  generate,
  loadCcuCodexIndexSource,
  loadCodexBarSource,
  mergeCodexSources,
  renderHeatmapSvg,
};
