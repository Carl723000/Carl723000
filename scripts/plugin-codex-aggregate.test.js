'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { projectPluginIndex } = require('./plugin-codex-aggregate');
const { modernIndex, testPlugin } = require('./plugin-codex-aggregate.test-fixture');

test('uses local dates, subsets and prices without repeated cached or reasoning tokens', () => {
  const result = projectPluginIndex(modernIndex(), { plugin: testPlugin });
  assert.deepEqual(result.daily, { '2026-10-13': 120 });
  assert.ok(Math.abs(result.apiEquivalent.equivalentUsd - 0.000256) < 1e-12);
  assert.equal(result.currentManifestVerified, false);
});

test('unknown models and unattributed residual tokens remain unpriced', () => {
  const index = modernIndex();
  index.files.current.aggregate.period.days['2026-10-13'].byModel = {
    known: { inputTotal: 40, cachedInput: 20, outputTotal: 20 },
    unlisted: { inputTotal: 30, cachedInput: 0, outputTotal: 0 },
  };
  const result = projectPluginIndex(index, { plugin: testPlugin });
  assert.equal(result.apiEquivalent.totalTokens, 120);
  assert.equal(result.apiEquivalent.pricedTokens, 60);
  assert.equal(result.apiEquivalent.pricingCoverage, 0.5);
  assert.deepEqual(result.unknownModels, ['unknown', 'unlisted']);
});

test('fails closed on incomplete coverage, unreadable periods, stale or pending lineage', () => {
  for (const change of [
    (i) => { i.coverage.complete = false; },
    (i) => { i.coverage.complete = undefined; },
    (i) => { delete i.files.current.aggregate.period; },
    (i) => { i.files.current.stale = true; },
    (i) => { i.files.current.qualityFlags = ['stale-file']; },
    (i) => { i.files.current.offset = 99; },
    (i) => { i.files.current.discardingOversizedLine = true; },
    (i) => { i.files.current.aggregate.period.indexedThrough = 0; },
    (i) => { i.files.current.lineageReconciliation = {}; },
    (i) => { i.files.current.lineage = { appliedPrefixEvents: 0, desiredPrefixEvents: 1 }; },
    (i) => { i.files.current.aggregate.total = { inputTotal: 101, outputTotal: 20 }; },
  ]) {
    const index = modernIndex(); change(index);
    assert.throws(() => projectPluginIndex(index, { plugin: testPlugin }));
  }
});
