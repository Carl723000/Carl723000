'use strict';

// Standard short-context USD per million tokens.
// https://developers.openai.com/api/docs/models/gpt-6.2-astra
// https://developers.openai.com/api/docs/models/gpt-6.2-sol
const GPT_62_PRICES = new Map([
  ['gpt-6.2-astra', { input: 8, cached: 0.40, output: 40, write30m: 10, write12h: 20 }],
  ['gpt-6.2-sol', { input: 2, cached: 0.10, output: 10, write30m: 2.50, write12h: 5 }],
]);

function gpt62EquivalentCost(model, tokens) {
  const name = model.trim().toLowerCase().replace(/^openai\//, '');
  const rates = GPT_62_PRICES.get(name);
  if (!rates) return undefined;

  const input = tokens.inputTotal;
  const output = tokens.outputTotal;
  const cached = Math.min(input, Math.max(0, tokens.cachedInput ?? 0));
  const cacheWrite = Math.min(input - cached, Math.max(0, tokens.cacheWriteInput ?? 0));
  const freshInputUsd = ((input - cached - cacheWrite) * rates.input + cacheWrite * rates.write30m) / 1e6;
  const cachedInputUsd = cached * rates.cached / 1e6;
  const outputUsd = output * rates.output / 1e6;
  const totalTokens = input + output;
  return {
    equivalentUsd: freshInputUsd + cachedInputUsd + outputUsd,
    freshInputUsd, cachedInputUsd, outputUsd, pricedTokens: totalTokens, totalTokens,
    pricingCoverage: totalTokens > 0 ? 1 : 0,
  };
}

module.exports = { gpt62EquivalentCost };
