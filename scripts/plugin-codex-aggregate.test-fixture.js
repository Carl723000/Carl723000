'use strict';

function modernIndex() {
  const tokens = { inputTotal: 100, cachedInput: 80, outputTotal: 20, reasoningOutput: 10 };
  return {
    schemaVersion: 3,
    files: {
      current: { offset: 100, size: 100, aggregate: { total: tokens, period: { indexedThrough: 100, timeZone: 'Asia/Shanghai', days: { '2026-10-13': { total: tokens, byModel: { known: tokens } } } } } },
    },
    aggregate: { total: tokens, byDay: { '2026-10-12': tokens } },
    coverage: { complete: true, period: { timeZone: 'Asia/Shanghai', asOfDay: '2026-10-13', allTime: { complete: true } } },
  };
}

const testPlugin = {
  normalizeCodexIndex: (index) => index,
  classifyCodexSessionDuplicates: (files) => ({ canonicalFileKeys: new Set(Object.keys(files)) }),
  isCodexUsageContributionCurrent: (file) => !file.stale,
  isReadableCodexPeriod: (file) => !!file.aggregate.period,
  equivalentCostBreakdownFromProviderTokens: (model, tokens) => {
    const totalTokens = tokens.inputTotal + tokens.outputTotal;
    const priced = model === 'known';
    const freshInputUsd = priced ? (tokens.inputTotal - tokens.cachedInput) * 2 / 1e6 : 0;
    const cachedInputUsd = priced ? tokens.cachedInput * 0.2 / 1e6 : 0;
    const outputUsd = priced ? tokens.outputTotal * 10 / 1e6 : 0;
    return { equivalentUsd: freshInputUsd + cachedInputUsd + outputUsd, freshInputUsd, cachedInputUsd, outputUsd, pricedTokens: priced ? totalTokens : 0, totalTokens };
  },
  summarizeEquivalentCostBreakdowns: (rows, expected) => {
    const result = { equivalentUsd: 0, freshInputUsd: 0, cachedInputUsd: 0, outputUsd: 0, pricedTokens: 0, totalTokens: 0 };
    for (const row of rows) for (const key of Object.keys(result)) result[key] += row[key] || 0;
    result.totalTokens = Math.max(result.totalTokens, expected || 0);
    result.pricingCoverage = result.totalTokens ? Math.min(1, result.pricedTokens / result.totalTokens) : 0;
    return result;
  },
};

module.exports = { modernIndex, testPlugin };
