'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  collectClaudeDaily,
  combineDaily,
  calendarZonesEquivalent,
  dayKeyInZone,
  loadCcuCodexIndexSource,
  loadClaudePluginHeatmapSource,
  loadCodexBarSource,
  mergeCodexSources,
  renderHeatmapSvg,
  resolveTimeZone,
} = require('./generate-heatmap');

async function temporaryDirectory(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'combined-heatmap-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

function claudeLine({
  timestamp = '2026-08-27T01:00:00.000Z',
  messageId = 'message-1',
  requestId = 'request-1',
  input = 10,
  output = 5,
  cacheWrite = 3,
  cacheRead = 7,
  model = 'claude-sonnet',
} = {}) {
  return JSON.stringify({
    timestamp,
    requestId,
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
      },
    },
  });
}

test('dayKeyInZone applies the configured calendar zone', () => {
  assert.equal(dayKeyInZone(new Date('2026-08-26T16:30:00Z'), 'Asia/Hong_Kong'), '2026-08-27');
  assert.equal(dayKeyInZone(new Date('2026-08-29T16:30:00Z'), 'Asia/Shanghai'), '2026-08-30');
  assert.equal(dayKeyInZone(new Date('2026-08-29T15:59:59Z'), 'Asia/Shanghai'), '2026-08-29');
  assert.equal(resolveTimeZone('local'), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(calendarZonesEquivalent('Asia/Hong_Kong', 'Asia/Shanghai'), true);
});

test('Claude collection counts all four buckets and keeps the larger duplicate', async (t) => {
  const root = await temporaryDirectory(t);
  const project = path.join(root, 'project', 'nested');
  await fsp.mkdir(project, { recursive: true });
  await fsp.writeFile(path.join(project, 'session.jsonl'), [
    claudeLine({ input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }),
    claudeLine({ input: 10, output: 5, cacheWrite: 3, cacheRead: 7 }),
    claudeLine({ messageId: '', requestId: '', input: 2, output: 3, cacheWrite: 0, cacheRead: 0 }),
    claudeLine({ messageId: 'synthetic', requestId: 'synthetic', model: '<synthetic>', input: 999 }),
    '{bad json',
  ].join('\n'));

  const result = await collectClaudeDaily({ roots: [root], timeZone: 'Asia/Hong_Kong' });
  assert.deepEqual(result.daily, { '2026-08-27': 30 });
  assert.equal(result.stats.duplicatesReplaced, 1);
  assert.equal(result.stats.parseErrors, 1);
});

function codexContribution(sourceArea, sessionKey, input, output) {
  const tokens = {
    inputTotal: input,
    cachedInput: Math.floor(input / 2),
    cacheWriteInput: 0,
    outputTotal: output,
    reasoningOutput: Math.floor(output / 2),
    sourceTotal: input + output,
  };
  return {
    sourceArea,
    offset: 100,
    size: 100,
    discardingOversizedLine: false,
    aggregate: {
      total: tokens,
      byModel: { model: tokens },
      byEffort: { high: tokens },
      session: { sessionKey, role: 'root', startedAt: 1, endedAt: 2 },
      structural: {
        patchCalls: 0,
        toolCalls: 0,
        postPatchToolCalls: 0,
        compactCount: 0,
        taskCompleteCount: 1,
      },
      period: {
        timeZone: 'Asia/Hong_Kong',
        days: {
          '2026-08-27': { total: tokens },
        },
      },
    },
  };
}

test('CCU Codex index excludes an exact active/archive duplicate without double-counting cached or reasoning tokens', async (t) => {
  const root = await temporaryDirectory(t);
  const indexPath = path.join(root, 'codex-index-v1.json');
  const active = codexContribution('sessions', 'same-session', 100, 20);
  const archive = codexContribution('archive', 'same-session', 100, 20);
  await fsp.writeFile(indexPath, JSON.stringify({ files: { active, archive } }));

  const source = await loadCcuCodexIndexSource(indexPath, 'Asia/Hong_Kong');
  assert.deepEqual(source.daily, { '2026-08-27': 120 });
  assert.equal(source.details.exactDuplicates, 1);
});

test('CCU Codex index rejects an explicitly incomplete checkpoint', async (t) => {
  const root = await temporaryDirectory(t);
  const indexPath = path.join(root, 'codex-index-v1.json');
  await fsp.writeFile(indexPath, JSON.stringify({
    files: {},
    aggregate: { byDay: { '2026-08-27': { inputTotal: 100, outputTotal: 20 } } },
    coverage: {
      indexedFiles: 1,
      totalFiles: 2,
      complete: false,
      identity: { complete: false },
      period: { timeZone: 'Asia/Hong_Kong', allTime: { complete: false } },
    },
  }));

  await assert.rejects(
    loadCcuCodexIndexSource(indexPath, 'Asia/Hong_Kong'),
    /index is still building \(1\/2 files\)/,
  );
});

test('CCU Codex index prefers its complete lineage-reconciled daily aggregate', async (t) => {
  const root = await temporaryDirectory(t);
  const indexPath = path.join(root, 'codex-index-v1.json');
  await fsp.writeFile(indexPath, JSON.stringify({
    files: {
      raw: codexContribution('sessions', 'raw-session', 1_000, 200),
    },
    aggregate: { byDay: { '2026-08-27': { inputTotal: 100, outputTotal: 20 } } },
    coverage: {
      indexedFiles: 1,
      totalFiles: 1,
      complete: true,
      identity: { complete: true, exactDuplicateFiles: 0, ambiguousSessionGroups: 0 },
      period: { timeZone: 'Asia/Hong_Kong', allTime: { complete: true } },
    },
  }));

  const source = await loadCcuCodexIndexSource(indexPath, 'Asia/Hong_Kong');
  assert.deepEqual(source.daily, { '2026-08-27': 120 });
  assert.equal(source.details.authoritativeAggregate, true);
});

test('CCU Codex index accepts an equivalent local timezone label', async (t) => {
  const root = await temporaryDirectory(t);
  const indexPath = path.join(root, 'codex-index-v1.json');
  await fsp.writeFile(indexPath, JSON.stringify({
    files: {},
    aggregate: { byDay: { '2026-08-27': { inputTotal: 100, outputTotal: 20 } } },
    coverage: {
      indexedFiles: 1,
      totalFiles: 1,
      complete: true,
      identity: { complete: true, exactDuplicateFiles: 0, ambiguousSessionGroups: 0 },
      period: { timeZone: 'Asia/Hong_Kong', allTime: { complete: true } },
    },
  }));

  const source = await loadCcuCodexIndexSource(indexPath, 'Asia/Shanghai');
  assert.deepEqual(source.daily, { '2026-08-27': 120 });
  assert.equal(source.details.timezoneEquivalent, true);
});

test('CCU Codex index keeps the plugin aggregate after the file scan completes even with unresolved identity groups', async (t) => {
  const root = await temporaryDirectory(t);
  const indexPath = path.join(root, 'codex-index-v1.json');
  await fsp.writeFile(indexPath, JSON.stringify({
    files: {},
    aggregate: { byDay: { '2026-08-27': { inputTotal: 100, outputTotal: 20 } } },
    coverage: {
      indexedFiles: 2,
      totalFiles: 2,
      complete: true,
      identity: { complete: false, exactDuplicateFiles: 0, ambiguousSessionGroups: 5 },
      period: { timeZone: 'Asia/Hong_Kong', allTime: { complete: true } },
    },
  }));

  const source = await loadCcuCodexIndexSource(indexPath, 'Asia/Hong_Kong');
  assert.deepEqual(source.daily, { '2026-08-27': 120 });
  assert.equal(source.details.identityComplete, false);
  assert.equal(source.details.ambiguousGroups, 5);
});

test('Claude plugin heatmap snapshot is accepted as aggregate input without reading transcripts', async (t) => {
  const root = await temporaryDirectory(t);
  const snapshotPath = path.join(root, 'claude-code-heatmap.svg');
  const endDateISO = '2026-08-27';
  const startISO = '2025-08-24';
  const cells = [];
  for (let iso = startISO; iso <= endDateISO;) {
    const date = new Date(`${iso}T00:00:00Z`);
    const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const number = date.getUTCDate();
    const lastTwo = number % 100;
    const suffix = lastTwo >= 11 && lastTwo <= 13
      ? 'th'
      : (['th', 'st', 'nd', 'rd'][Math.min(number % 10, 4)] || 'th');
    const label = iso === endDateISO ? '1.2M tokens' : 'No tokens';
    cells.push(`<rect><title>${label} on ${month} ${number}${suffix}</title></rect>`);
    iso = new Date(date.getTime() + 86_400_000).toISOString().slice(0, 10);
  }
  await fsp.writeFile(snapshotPath, `<svg><text>1.2M tokens in Claude Code · 2026</text>${cells.join('')}</svg>`);

  const source = await loadClaudePluginHeatmapSource(snapshotPath, {
    timeZone: 'Asia/Hong_Kong',
    snapshotEndDateISO: endDateISO,
  });
  assert.equal(source.daily[endDateISO], 1_200_000);
  assert.equal(source.stats.cells, 369);
  assert.equal(source.stats.source, 'plugin-heatmap');
});

test('CodexBar source reads input plus output only', async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = path.join(root, 'cost-usage.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE day_aggregates(day TEXT, input_tokens INTEGER, output_tokens INTEGER)');
  database.exec("INSERT INTO day_aggregates VALUES ('2026-08-27', 100, 20), ('2026-08-27', 40, 5)");
  database.close();

  const source = await loadCodexBarSource(databasePath);
  assert.deepEqual(source.daily, { '2026-08-27': 165 });
});

test('newer Codex source owns overlap while older source fills earlier history', () => {
  const merged = mergeCodexSources([
    {
      kind: 'ccu-index',
      mtimeMs: 1,
      daily: { '2026-08-25': 10, '2026-08-26': 20, '2026-08-27': 30 },
      coverage: { firstDay: '2026-08-25', lastDay: '2026-08-27' },
    },
    {
      kind: 'codexbar',
      mtimeMs: 2,
      daily: { '2026-08-26': 200 },
      coverage: { firstDay: '2026-08-26', lastDay: '2026-08-27' },
    },
  ]);
  assert.deepEqual(merged.daily, {
    '2026-08-25': 10,
    '2026-08-26': 200,
    '2026-08-27': 0,
  });
});

test('SVG title and tooltips identify the combined provider totals', () => {
  const daily = combineDaily({ '2026-08-27': 25 }, { '2026-08-27': 120 });
  const rendered = renderHeatmapSvg(daily, {
    endDateISO: '2026-08-27',
    timeZone: 'Asia/Hong_Kong',
  });
  assert.match(rendered.svg, /145 AI coding tokens · Claude Code \+ Codex · trailing 12 months/);
  assert.match(rendered.svg, /145 tokens on August 27th \(Claude 25 \+ Codex 120\)/);
  assert.match(rendered.svg, /Claude 25/);
  assert.match(rendered.svg, /Codex 120/);
});

test('SVG uses six maximum-relative levels so real peaks keep the darkest colour', () => {
  const daily = combineDaily({
    '2026-08-23': 1,
    '2026-08-24': 100,
    '2026-08-25': 200,
    '2026-08-26': 500,
    '2026-08-27': 1_000,
  }, {});
  const rendered = renderHeatmapSvg(daily, {
    endDateISO: '2026-08-27',
    timeZone: 'Asia/Hong_Kong',
  });

  assert.match(rendered.svg, /fill="#eee8f8"><title>1 tokens on August 23rd/);
  assert.match(rendered.svg, /fill="#d8c9f1"><title>100 tokens on August 24th/);
  assert.match(rendered.svg, /fill="#bca5e6"><title>200 tokens on August 25th/);
  assert.match(rendered.svg, /fill="#8668c7"><title>500 tokens on August 26th/);
  assert.match(rendered.svg, /fill="#4f2f87"><title>1K tokens on August 27th/);
  const paletteCells = rendered.svg.match(
    /fill="#(?:ebedf0|eee8f8|d8c9f1|bca5e6|8668c7|4f2f87)"/g,
  ) || [];
  assert.ok(paletteCells.length > 6);
});
