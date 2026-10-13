'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateClaudeCheckpoint, loadClaudeCheckpoint, MAX_CHECKPOINT_BYTES } = require('./profile-heatmap-data');

const options = { targetDay: '2026-10-13', timeZone: 'Asia/Shanghai', now: '2026-10-13T12:00:00.000Z' };
function row(overrides = {}) {
  return { tokens: 100, amountUSD: 1.234567, pricingStatus: 'complete', estimated: true,
    pricedCount: 100, unpricedCount: 0, sourceComplete: true, ...overrides };
}
function checkpoint(overrides = {}) {
  return { schemaVersion: 1, provider: 'claude', currency: 'USD', timeZone: 'Asia/Shanghai',
    asOfDay: '2026-10-13', generatedAt: '2026-10-13T11:00:00.000Z', sourceComplete: true,
    dataRevision: 12, pricingRevision: 34, claudeBackend: 'anthropic',
    daily: { '2026-10-13': row() }, ...overrides };
}
function rejects(value, pattern = /Invalid Claude checkpoint/, settings = options) {
  assert.throws(() => validateClaudeCheckpoint(value, settings), pattern);
}
async function directory(t) {
  const value = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-checkpoint-test-'));
  t.after(() => fsp.rm(value, { recursive: true, force: true }));
  return value;
}

test('retains precise producer values in a new whitelisted projection', () => {
  const source = checkpoint();
  const result = validateClaudeCheckpoint(source, options);
  assert.deepEqual(result.daily, source.daily);
  assert.notEqual(result.daily, source.daily);
  assert.notEqual(result.daily['2026-10-13'], source.daily['2026-10-13']);
  assert.equal(result.metadata.generatedAt, source.generatedAt);
  assert.equal(result.stats.tokens, 100);
  assert.equal(result.stats.amountUSD, 1.234567);
  assert.equal(result.stats.pricingComplete, true);
  source.daily['2026-10-13'].tokens = 999;
  assert.equal(result.daily['2026-10-13'].tokens, 100);
});

test('empty, explicitly priced zero, partial and unpriced remain distinct', () => {
  const source = checkpoint({ daily: {
    '2026-10-10': row({ tokens: 0, amountUSD: null, pricingStatus: 'empty', pricedCount: 0 }),
    '2026-10-11': row({ tokens: 0, amountUSD: 0, pricedCount: 0 }),
    '2026-10-12': row({ tokens: 100, amountUSD: 0.001234, pricingStatus: 'partial', pricedCount: 40, unpricedCount: 60 }),
    '2026-10-13': row({ tokens: 100, amountUSD: null, pricingStatus: 'unpriced', pricedCount: 0, unpricedCount: 100 }),
  } });
  const result = validateClaudeCheckpoint(source, options);
  assert.equal(result.stats.tokens, 200);
  assert.equal(result.stats.amountUSD, 0.001234);
  assert.equal(result.stats.pricedCount, 40);
  assert.equal(result.stats.unpricedCount, 160);
  assert.equal(result.stats.pricingComplete, false);
  assert.equal(result.daily['2026-10-13'].amountUSD, null);
  assert.equal(result.daily['2026-10-11'].amountUSD, 0);
  assert.equal(result.daily['2026-10-10'].amountUSD, null);
  const unknownOnly = validateClaudeCheckpoint(checkpoint({ daily: {
    '2026-10-13': row({ amountUSD: null, pricingStatus: 'unpriced', pricedCount: 0, unpricedCount: 100 }),
  } }), options);
  assert.equal(unknownOnly.stats.amountUSD, null);
  assert.equal(unknownOnly.stats.pricingComplete, false);
});

test('freshness uses observation time and current local target day', () => {
  rejects(checkpoint({ generatedAt: '2026-10-12T23:59:59.000Z' }), /stale/);
  rejects(checkpoint({ generatedAt: '2026-10-12T15:59:59.000Z' }), /not on targetDay/);
  rejects(checkpoint({ asOfDay: '2026-10-12' }), /does not match/);
  rejects(checkpoint({ generatedAt: '2026-10-13T12:05:00.001Z' }), /future/);
  validateClaudeCheckpoint(checkpoint({ generatedAt: '2026-10-13T12:05:00.000Z' }), options);
  validateClaudeCheckpoint(checkpoint({ generatedAt: '2026-10-13T00:00:00.000Z' }), options);
  rejects(checkpoint(), /stale/, { ...options, maxAgeMs: 1000 });
  rejects(checkpoint(), /current/, { ...options, now: '2026-10-14T12:00:00.000Z' });
  for (const maxAgeMs of [-1, Infinity, NaN, '100']) rejects(checkpoint(), /maxAgeMs/, { ...options, maxAgeMs });
});

test('accepts calendar-equivalent aliases and rejects different calendar zones', () => {
  validateClaudeCheckpoint(checkpoint({ timeZone: 'Asia/Hong_Kong' }), options);
  rejects(checkpoint({ timeZone: 'America/New_York' }), /timezone mismatch/);
  for (const timeZone of ['local', '+08:00', 'Mars/Unknown', ' Asia/Shanghai']) {
    rejects(checkpoint({ timeZone }), /timezone/i);
  }
});

test('requires exact supported producer metadata and no unknown fields', () => {
  for (const override of [{ schemaVersion: 2 }, { provider: 'codex' }, { currency: 'CNY' },
    { currency: 'usd' }, { claudeBackend: 'unknown' }, { sourceComplete: false },
    { sourceComplete: undefined }, { dataRevision: -1 }, { pricingRevision: 1.5 },
    { dataRevision: Number.MAX_SAFE_INTEGER + 1 }]) rejects(checkpoint(override));
  validateClaudeCheckpoint(checkpoint({ claudeBackend: 'aws-bedrock-in-region' }), options);
  for (const key of ['path', 'sessionId', 'prompt', 'records', '__proto__', 'mtimeMs']) {
    const value = checkpoint();
    Object.defineProperty(value, key, { enumerable: true, value: 'sensitive' });
    rejects(value, /unsupported fields/);
    rejects(checkpoint({ daily: { '2026-10-13': { ...row(), [key]: 'sensitive' } } }), /unsupported fields/);
  }
  const missing = checkpoint();
  delete missing.sourceComplete;
  rejects(missing, /missing required/);
});

test('rejects invalid dates and timestamp normalization tricks', () => {
  for (const date of ['2026-02-30', '2026-13-01', '2026-1-01', '2026-10-14', '2025-10-12', '__proto__']) {
    rejects(checkpoint({ daily: { [date]: row() } }));
  }
  for (const generatedAt of ['2026-02-30T11:00:00.000Z', '2026-10-13T25:00:00.000Z',
    '2026-10-13', '2026-10-13T11:00:00+00:00', '2026-10-13T11:00:00.000Z junk']) {
    rejects(checkpoint({ generatedAt }));
  }
  validateClaudeCheckpoint(checkpoint({ generatedAt: '2026-10-13T11:00:00Z' }), options);
  validateClaudeCheckpoint(checkpoint({ daily: { '2025-10-13': row() } }), options);
});

test('does not infer pricing from unknown or contradictory row data', () => {
  for (const override of [
    { estimated: false }, { sourceComplete: false }, { sourceComplete: undefined },
    { amountUSD: -1 }, { amountUSD: Infinity }, { amountUSD: NaN }, { amountUSD: '0' },
    { tokens: 1.1 }, { tokens: -1 }, { pricedCount: -1 }, { unpricedCount: 1 },
    { tokens: Number.MAX_SAFE_INTEGER + 1 }, { pricingStatus: 'unknown' },
    { pricingStatus: 'empty' }, { pricingStatus: 'complete', amountUSD: null },
    { pricingStatus: 'partial', unpricedCount: 0 },
    { pricingStatus: 'partial', tokens: 100, pricedCount: 0, unpricedCount: 100 },
    { pricingStatus: 'partial', tokens: 100, pricedCount: 40, unpricedCount: 60, amountUSD: null },
    { pricingStatus: 'unpriced', amountUSD: 0, pricedCount: 0, unpricedCount: 100 },
    { tokens: 0, amountUSD: 10, pricedCount: 0 },
    { pricingStatus: 'unpriced', tokens: 0, amountUSD: null, pricedCount: 0 },
  ]) rejects(checkpoint({ daily: { '2026-10-13': row(override) } }));
});

test('bounds all daily totals and input objects without executing accessors', () => {
  rejects(checkpoint({ daily: { '2026-10-12': row({ tokens: Number.MAX_SAFE_INTEGER, pricedCount: Number.MAX_SAFE_INTEGER }),
    '2026-10-13': row() } }), /total tokens/);
  rejects(checkpoint({ daily: { '2026-10-12': row({ amountUSD: Number.MAX_VALUE }),
    '2026-10-13': row({ amountUSD: Number.MAX_VALUE }) } }), /amountUSD|overflow/);
  rejects(checkpoint({ daily: Array(367).fill(row()) }), /plain object/);
  rejects(checkpoint({ daily: Object.fromEntries(Array.from({ length: 367 }, (_, i) => [`day${i}`, row()])) }), /366/);
  const accessor = checkpoint();
  Object.defineProperty(accessor, 'daily', { enumerable: true, get() { throw new Error('must not execute'); } });
  rejects(accessor, /accessors/);
  const symbol = checkpoint();
  symbol[Symbol('private')] = 'secret';
  rejects(symbol, /unsupported fields/);
  const symbolDay = checkpoint();
  symbolDay.daily[Symbol('private')] = row();
  rejects(symbolDay, /ISO calendar day/);
  const accessorDay = checkpoint();
  Object.defineProperty(accessorDay.daily, '2026-10-13', { enumerable: true, get() { throw new Error('must not execute'); } });
  rejects(accessorDay, /accessors/);
});

test('file loader uses generatedAt even when stale file is copied with a new mtime', async t => {
  const root = await directory(t);
  const original = path.join(root, 'original.json');
  const copy = path.join(root, 'copy.json');
  await fsp.writeFile(original, JSON.stringify(checkpoint({ generatedAt: '2026-10-12T23:00:00.000Z' })));
  await fsp.copyFile(original, copy);
  await fsp.utimes(copy, new Date(options.now), new Date(options.now));
  await assert.rejects(loadClaudeCheckpoint(copy, options), /stale/);
  await fsp.writeFile(copy, JSON.stringify(checkpoint()));
  const result = await loadClaudeCheckpoint(copy, options);
  assert.equal(result.metadata.generatedAt, '2026-10-13T11:00:00.000Z');
});

test('file loader rejects symlinks, directories, malformed JSON and oversized files', async t => {
  const root = await directory(t);
  const file = path.join(root, 'data.json');
  const link = path.join(root, 'link.json');
  await fsp.writeFile(file, JSON.stringify(checkpoint()));
  await fsp.symlink(file, link);
  await assert.rejects(loadClaudeCheckpoint(link, options), /regular file/);
  await assert.rejects(loadClaudeCheckpoint(root, options), /regular file/);
  await fsp.writeFile(file, '{invalid');
  await assert.rejects(loadClaudeCheckpoint(file, options), /valid JSON/);
  await fsp.writeFile(file, Buffer.alloc(MAX_CHECKPOINT_BYTES + 1));
  await assert.rejects(loadClaudeCheckpoint(file, options), /bounded regular file/);
});
