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
  dayKeyInZone,
  loadCcuCodexIndexSource,
  loadCodexBarSource,
  mergeCodexSources,
  renderHeatmapSvg,
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
  assert.match(rendered.svg, /145 tokens in Claude Code \+ Codex · 2026/);
  assert.match(rendered.svg, /145 tokens on August 27th \(Claude 25 \+ Codex 120\)/);
  assert.match(rendered.svg, /Claude 25/);
  assert.match(rendered.svg, /Codex 120/);
});
