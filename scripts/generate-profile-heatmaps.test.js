'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { PROFILE_IMAGES, wholeMoney, renderProfilePair, replaceImagePair, generateProfileHeatmaps } = require('./generate-profile-heatmaps');

const now = new Date('2026-10-13T02:00:00.000Z');
function checkpoint() {
  return { schemaVersion: 1, provider: 'claude', currency: 'USD', timeZone: 'Asia/Shanghai',
    asOfDay: '2026-10-13', generatedAt: now.toISOString(), sourceComplete: true,
    dataRevision: 1, pricingRevision: 1, claudeBackend: 'anthropic',
    daily: { '2026-10-12': { tokens: 100, amountUSD: 0.6, pricingStatus: 'complete', estimated: true, pricedCount: 100, unpricedCount: 0, sourceComplete: true },
      '2026-10-13': { tokens: 100, amountUSD: 0.6, pricingStatus: 'complete', estimated: true, pricedCount: 100, unpricedCount: 0, sourceComplete: true } } };
}
function codex() {
  return { daily: { '2026-10-13': 120 }, dailyCosts: { '2026-10-13': { equivalentUsd: 2.4, totalTokens: 120, pricedTokens: 100 } },
    mtimeMs: now.getTime(), details: { asOfDay: '2026-10-13', localDayProjection: true, indexedTimeZone: 'Asia/Shanghai', ambiguousGroups: 0 } };
}
function codexCheckpoint() {
  const value = checkpoint();
  value.provider = 'codex'; delete value.claudeBackend;
  value.currentManifestVerified = true;
  value.daily = { '2026-10-13': { tokens: 120, amountUSD: 2.4, pricingStatus: 'partial', estimated: false, pricedCount: 100, unpricedCount: 20, sourceComplete: true } };
  return value;
}
function renderer() {
  const calls = [];
  const scale = ['#ebedf0', '#eee8f8', '#d8c9f1', '#bca5e6', '#8668c7', '#4f2f87'];
  return { calls, normalizeCombinedHeatmapPalette: (p) => p || 'academicViolet',
    COMBINED_ACTIVITY_PALETTES: { academicViolet: scale },
    customCombinedHeatmapScale: () => scale,
    render: (daily, options) => {
      calls.push({ daily, options });
      return `<svg width="843" height="177"><text>${options.title}</text><title>${options.tooltip('2026-10-13')}</title></svg>`;
    } };
}

test('precision is retained through summation and providers remain separate', () => {
  const r = renderer();
  const pair = renderProfilePair({ daily: checkpoint().daily }, codex(), { targetDay: '2026-10-13', timeZone: 'Asia/Shanghai', renderer: r });
  assert.equal(pair.summary.token.total, 320);
  assert.equal(pair.summary.costs[0].totalUSD, 1.2);
  assert.match(r.calls[0].options.title, /^\$1 API-equivalent · Claude Code/);
  assert.match(r.calls[1].options.title, /^\$2\+ API-equivalent · Codex/);
  assert.match(pair.images[PROFILE_IMAGES[1]], /data-provider="claude"/);
  assert.match(pair.images[PROFILE_IMAGES[1]], /data-provider="codex"/);
  assert.equal(wholeMoney(0.2), '<$1');
});

test('explicit zero, entirely unpriced and no recorded activity do not collapse', () => {
  const c = checkpoint(); const r = renderer();
  c.daily = { '2026-10-13': { tokens: 0, amountUSD: 0, pricingStatus: 'complete', pricedCount: 0, unpricedCount: 0 } };
  renderProfilePair(c, codex(), { targetDay: '2026-10-13', timeZone: 'Asia/Shanghai', renderer: r });
  assert.match(r.calls[0].options.title, /^\$0 API/);
  c.daily['2026-10-13'] = { tokens: 10, amountUSD: null, pricingStatus: 'unpriced', pricedCount: 0, unpricedCount: 10 };
  renderProfilePair(c, codex(), { targetDay: '2026-10-13', timeZone: 'Asia/Shanghai', renderer: r });
  assert.match(r.calls[2].options.title, /^Unpriced/);
  assert.equal(r.calls[2].options.cellStyle('2026-10-13').dashed, true);
  renderProfilePair({ daily: {} }, codex(), { targetDay: '2026-10-13', timeZone: 'Asia/Shanghai', renderer: r });
  assert.match(r.calls[4].options.title, /^No data/);
});

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-pair-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of PROFILE_IMAGES) await fs.writeFile(path.join(root, name), 'old:' + name);
  return root;
}

test('stale Claude or stale/wrong-zone Codex leaves both public files untouched', async (t) => {
  const repoRoot = await temp(t);
  for (const change of [
    (args) => { args.claudeCheckpoint.generatedAt = '2026-08-27T02:00:00.000Z'; },
    (args) => { args.codexCheckpoint.asOfDay = '2026-10-12'; },
    (args) => { args.codexCheckpoint.timeZone = 'Europe/Istanbul'; },
    (args) => { args.codexCheckpoint.generatedAt = '2026-10-12T02:00:00.000Z'; },
    (args) => { args.codexCheckpoint.currentManifestVerified = false; },
    (args) => { args.codexCheckpoint.generatedAt = '2026-10-13T01:00:00.000Z'; },
  ]) {
    const args = { repoRoot, now, localConfig: { timeZone: 'local' }, timeZone: 'Asia/Shanghai', claudeCheckpoint: checkpoint(), codexCheckpoint: codexCheckpoint(), renderer: renderer() };
    change(args);
    await assert.rejects(generateProfileHeatmaps(args));
    for (const name of PROFILE_IMAGES) assert.equal(await fs.readFile(path.join(repoRoot, name), 'utf8'), 'old:' + name);
  }
});

test('second-image rendering failure leaves the previous pair intact', async (t) => {
  const repoRoot = await temp(t); const r = renderer();
  const base = r.render; r.render = (...args) => { if (r.calls.length === 1) throw new Error('render fail'); return base(...args); };
  await assert.rejects(generateProfileHeatmaps({ repoRoot, now, timeZone: 'Asia/Shanghai', localConfig: {}, claudeCheckpoint: checkpoint(), codexCheckpoint: codexCheckpoint(), renderer: r }), /render fail/);
  for (const name of PROFILE_IMAGES) assert.equal(await fs.readFile(path.join(repoRoot, name), 'utf8'), 'old:' + name);
});

test('second replacement failure restores both files and cleans only owned temps', async (t) => {
  const repoRoot = await temp(t);
  const io = { ...fs, rename: async (from, to) => { if (to.endsWith(PROFILE_IMAGES[1]) && !from.endsWith('-backup')) throw new Error('rename fail'); return fs.rename(from, to); } };
  await assert.rejects(replaceImagePair(repoRoot, Object.fromEntries(PROFILE_IMAGES.map(name => [name, '<svg new="yes"/>'])), io), /rename fail/);
  for (const name of PROFILE_IMAGES) assert.equal(await fs.readFile(path.join(repoRoot, name), 'utf8'), 'old:' + name);
  assert.deepEqual((await fs.readdir(repoRoot)).sort(), [...PROFILE_IMAGES].sort());
});

test('preflight disk-full failure never writes either public file', async (t) => {
  const repoRoot = await temp(t);
  let publicWrites = 0;
  const io = { ...fs, writeFile: async (file, ...args) => {
    if (PROFILE_IMAGES.some(name => file === path.join(repoRoot, name))) { publicWrites += 1; throw new Error('public file must not be opened for writing'); }
    if (file.includes(PROFILE_IMAGES[1] + '.tmp-')) throw new Error('disk full');
    return fs.writeFile(file, ...args);
  } };
  await assert.rejects(replaceImagePair(repoRoot, Object.fromEntries(PROFILE_IMAGES.map(name => [name, '<svg new="yes"/>'])), io), /disk full/);
  assert.equal(publicWrites, 0);
  for (const name of PROFILE_IMAGES) assert.equal(await fs.readFile(path.join(repoRoot, name), 'utf8'), 'old:' + name);
});

test('success prepares and replaces the full pair after validation', async (t) => {
  const repoRoot = await temp(t);
  await generateProfileHeatmaps({ repoRoot, now, timeZone: 'Asia/Shanghai', localConfig: {}, claudeCheckpoint: checkpoint(), codexCheckpoint: codexCheckpoint(), renderer: renderer() });
  for (const name of PROFILE_IMAGES) assert.match(await fs.readFile(path.join(repoRoot, name), 'utf8'), /^<svg /);
});

test('one atomic capture preserves provider quality states and rejects mixed generations', async (t) => {
  const repoRoot = await temp(t);
  const capture = { schemaVersion: 1, claude: checkpoint(), codex: codexCheckpoint() };
  capture.codex.daily = { '2026-10-13': { tokens: 0, amountUSD: null, pricingStatus: 'empty', estimated: false, pricedCount: 0, unpricedCount: 0, sourceComplete: true } };
  const r = renderer();
  await generateProfileHeatmaps({ repoRoot, now, timeZone: 'Asia/Shanghai', localConfig: {}, profileCapture: capture, renderer: r, previewOnly: true });
  assert.match(r.calls[1].options.title, /^No data/);
  capture.codex.generatedAt = '2026-10-13T01:00:00.000Z';
  await assert.rejects(generateProfileHeatmaps({ repoRoot, now, timeZone: 'Asia/Shanghai', localConfig: {}, profileCapture: capture, renderer: renderer() }), /observations do not match/);
  for (const name of PROFILE_IMAGES) assert.equal(await fs.readFile(path.join(repoRoot, name), 'utf8'), 'old:' + name);
});
