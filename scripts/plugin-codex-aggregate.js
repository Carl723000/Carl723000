'use strict';

// Consume the extension's persisted numeric aggregates only. Never instantiate
// its provider/worker: those would scan logs and load the session-title cache.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function installedPluginOut(environment = process.env, home = os.homedir()) {
  if (environment.CCU_PLUGIN_OUT) return environment.CCU_PLUGIN_OUT;
  const root = path.join(home, '.vscode', 'extensions');
  const names = fs.readdirSync(root).filter((name) => /^growthjack\.claude-code-usage-\d+\.\d+\.\d+$/.test(name));
  names.sort((a, b) => {
    const left = a.match(/(\d+)\.(\d+)\.(\d+)$/).slice(1).map(Number);
    const right = b.match(/(\d+)\.(\d+)\.(\d+)$/).slice(1).map(Number);
    for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return right[i] - left[i];
    return 0;
  });
  if (!names.length) throw new Error('Install Claude Code Usage before projecting its Codex aggregate');
  return path.join(root, names[0], 'out');
}

function pluginFunctions(out) {
  return {
    ...require(path.join(out, 'providers', 'codex', 'codexIndex.js')),
    ...require(path.join(out, 'providers', 'codex', 'codexDedup.js')),
    ...require(path.join(out, 'weeklyValue.js')),
  };
}

function processed(tokens) { return tokens.inputTotal + tokens.outputTotal; }

function projectPluginIndex(raw, options = {}) {
  const plugin = options.plugin || pluginFunctions(options.pluginOut || installedPluginOut());
  const index = plugin.normalizeCodexIndex(raw);
  const timeZone = index.coverage.period.timeZone;
  if (!index.coverage.complete || !index.coverage.period.allTime.complete) {
    throw new Error('The plugin aggregate/period projection is not complete');
  }
  const { canonicalFileKeys } = plugin.classifyCodexSessionDuplicates(index.files);
  const daily = {};
  const dailyCosts = {};
  const unknownModels = new Set();
  let expectedTokens = 0;
  for (const key of canonicalFileKeys) {
    const file = index.files[key];
    if (file.offset !== file.size || file.discardingOversizedLine || file.qualityFlags?.includes('stale-file')
      || !(file.aggregate.period?.indexedThrough >= file.offset)) {
      throw new Error('A Codex contribution/local-day cursor is not fully indexed');
    }
    if (!plugin.isCodexUsageContributionCurrent(file)) {
      throw new Error('A Codex contribution still needs refreshing in the plugin');
    }
    if (file.lineageReconciliation || (file.lineage && file.lineage.appliedPrefixEvents !== file.lineage.desiredPrefixEvents)) {
      throw new Error('The plugin is still reconciling a Codex aggregate');
    }
    if (!plugin.isReadableCodexPeriod(file, timeZone)) {
      throw new Error('A Codex local-day sidecar still needs rebuilding in the plugin');
    }
    expectedTokens += processed(file.aggregate.total);
    for (const [day, slice] of Object.entries(file.aggregate.period.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid plugin calendar day');
      const total = processed(slice.total);
      daily[day] = (daily[day] || 0) + total;
      const costs = [];
      let attributedInput = 0;
      let attributedOutput = 0;
      for (const [model, tokens] of Object.entries(slice.byModel || {})) {
        const cost = plugin.equivalentCostBreakdownFromProviderTokens(model, tokens);
        if (cost.pricedTokens < cost.totalTokens) unknownModels.add(model);
        costs.push(cost);
        attributedInput += tokens.inputTotal;
        attributedOutput += tokens.outputTotal;
      }
      const residual = Math.max(0, slice.total.inputTotal - attributedInput)
        + Math.max(0, slice.total.outputTotal - attributedOutput);
      if (residual) unknownModels.add('unknown');
      const piece = plugin.summarizeEquivalentCostBreakdowns(costs, total);
      dailyCosts[day] = plugin.summarizeEquivalentCostBreakdowns(
        [dailyCosts[day], piece].filter(Boolean),
        daily[day],
      );
    }
  }
  const observedTokens = Object.values(daily).reduce((sum, value) => sum + value, 0);
  if (observedTokens !== expectedTokens) {
    throw new Error(`Codex local-day projection does not reconcile (${observedTokens}/${expectedTokens} tokens)`);
  }
  return {
    daily,
    dailyCosts,
    apiEquivalent: plugin.summarizeEquivalentCostBreakdowns(Object.values(dailyCosts), expectedTokens),
    unknownModels: [...unknownModels].sort(),
    timeZone,
    asOfDay: index.coverage.period.asOfDay,
    currentManifestVerified: false,
    pricingBasis: 'installed-plugin-model-prices',
  };
}

module.exports = { installedPluginOut, projectPluginIndex };
