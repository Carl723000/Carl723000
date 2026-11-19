#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { addDays, dayKeyInZone, combineDaily, renderHeatmapSvg, resolveTimeZone } = require('./generate-heatmap');
const { installedPluginOut } = require('./plugin-codex-aggregate');
const { loadProfileCapture, validateProfileCapture } = require('./profile-heatmap-data');

const PROFILE_IMAGES = ['claude-code-heatmap.svg', 'api-equivalent-heatmap.svg'];
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const wholeMoney = (value) => value > 0 && value < 1 ? '<$1' : '$' + Math.round(value).toLocaleString('en-US');

function pluginRenderer(out = installedPluginOut()) {
  const palettes = require(path.join(out, 'combinedHeatmapSvg.js'));
  return { ...palettes, render: require(path.join(out, 'heatmapSvg.js')).renderHeatmapSvg };
}

function amountBlock(daily, name, options, renderer, scale) {
  const days = [];
  for (let day = options.startDay; day <= options.targetDay; day = addDays(day, 1)) {
    if (daily[day]) days.push([day, daily[day]]);
  }
  const amounts = days.filter(([, row]) => row.amountUSD !== null);
  const total = amounts.reduce((sum, [, row]) => sum + row.amountUSD, 0);
  const priced = days.reduce((sum, [, row]) => sum + row.pricedCount, 0);
  const unpriced = days.reduce((sum, [, row]) => sum + row.unpricedCount, 0);
  const hasActivity = days.some(([, row]) => row.tokens > 0 || row.pricingStatus === 'complete');
  const amountLabel = !hasActivity ? 'No data' : !priced && days.some(([, row]) => row.tokens > 0)
    ? 'Unpriced' : wholeMoney(total);
  const coverage = priced + unpriced > 0 ? priced / (priced + unpriced) : 1;
  const title = `${amountLabel} API-equivalent · ${name} · trailing 12 months`;
  const maximum = Math.max(0, ...amounts.map(([, row]) => row.amountUSD));
  const usage = Object.fromEntries(days.map(([day, row]) => [day, { tokens: row.tokens, cost: row.amountUSD ?? 0, sessions: 0 }]));
  const svg = renderer.render(usage, {
    metric: 'cost', startDateISO: options.startDay, endDateISO: options.targetDay,
    title, locale: 'en', scale, intensityMode: 'linear',
    watermark: name,
    ariaLabel: title,
    tooltip: (day) => {
      const row = daily[day];
      if (!row || row.pricingStatus === 'empty') return `${day} · No recorded activity`;
      if (row.pricingStatus === 'unpriced') return `${day} · ${name} · Unpriced`;
      return `${day} · ${name} · ${wholeMoney(row.amountUSD)} API-equivalent`;
    },
    cellStyle: (day) => {
      const row = daily[day];
      if (!row || row.pricingStatus === 'empty') return { fill: scale[0] };
      if (row.pricingStatus === 'unpriced') return { fill: scale[0] };
      const band = row.amountUSD <= 0 ? 0 : 1 + [0.05, 0.15, 0.35, 0.65].filter((ratio) => row.amountUSD > maximum * ratio).length;
      return { fill: scale[band] };
    },
  });
  return { svg, totalUSD: total, pricedTokens: priced, unpricedTokens: unpriced, coverage };
}

function codexDailyCosts(codex) {
  return codex.providerDaily || Object.fromEntries(Object.entries(codex.dailyCosts).map(([day, cost]) => [day, {
    tokens: codex.daily[day], amountUSD: cost.pricedTokens > 0 ? cost.equivalentUsd : cost.totalTokens > 0 ? null : 0,
    pricingStatus: cost.totalTokens === 0 ? 'complete' : cost.pricedTokens === 0 ? 'unpriced'
      : cost.pricedTokens < cost.totalTokens ? 'partial' : 'complete',
    pricedCount: cost.pricedTokens, unpricedCount: cost.totalTokens - cost.pricedTokens,
  }]));
}

function renderCodexFeePreview(codex, options = {}) {
  const renderer = options.renderer || pluginRenderer(options.pluginOut);
  const targetDay = codex.asOfDay;
  return amountBlock(codexDailyCosts(codex), 'Codex', { targetDay, startDay: addDays(targetDay, -365) },
    renderer, renderer.COMBINED_ACTIVITY_PALETTES.academicViolet);
}

function renderProfilePair(claude, codex, options = {}) {
  const renderer = options.renderer || pluginRenderer(options.pluginOut);
  const palette = renderer.normalizeCombinedHeatmapPalette(options.palette);
  const scale = palette === 'custom' ? renderer.customCombinedHeatmapScale(options.customAccent)
    : renderer.COMBINED_ACTIVITY_PALETTES[palette];
  const startDay = addDays(options.targetDay, -365);
  const claudeTokens = Object.fromEntries(Object.entries(claude.daily).map(([day, row]) => [day, row.tokens]));
  const token = renderHeatmapSvg(combineDaily(claudeTokens, codex.daily), {
    timeZone: options.timeZone, startDateISO: startDay, endDateISO: options.targetDay, scale,
  });
  const blocks = [amountBlock(claude.daily, 'Claude Code', { ...options, startDay }, renderer, scale),
    amountBlock(codexDailyCosts(codex), 'Codex', { ...options, startDay }, renderer, scale)];
  const sizes = blocks.map(({ svg }) => svg.match(/width="(\d+)" height="(\d+)"/).slice(1).map(Number));
  const width = Math.max(...sizes.map(([w]) => w));
  const height = sizes[0][1] + sizes[1][1] + 12;
  const costSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Claude Code and Codex API-equivalent heatmaps">\n`
    + blocks.map(({ svg }, i) => svg.replace(/^<svg /, `<svg x="0" y="${i ? sizes[0][1] + 12 : 0}" data-provider="${i ? 'codex' : 'claude'}" `)).join('\n') + '\n</svg>';
  return { images: { [PROFILE_IMAGES[0]]: token.svg, [PROFILE_IMAGES[1]]: costSvg },
    summary: { token: token.summary, costs: blocks.map(({ svg, ...summary }) => summary), timeZone: options.timeZone, asOfDay: options.targetDay } };
}

// Prepare/validate the entire pair before touching either public path. Remote
// publication is one Git commit; local replacement exceptions restore both files.
async function replaceImagePair(repoRoot, images, io = fs) {
  const id = randomUUID();
  const saved = new Map();
  const staged = new Map();
  const backups = new Map();
  const replaced = [];
  let recoveryFailed = false;
  for (const name of PROFILE_IMAGES) {
    if (typeof images[name] !== 'string' || !images[name].startsWith('<svg ')) throw new Error(`Invalid generated ${name}`);
    try {
      const stat = await io.lstat(path.join(repoRoot, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Public heatmap paths must be regular files');
      saved.set(name, await io.readFile(path.join(repoRoot, name)));
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; saved.set(name, null); }
  }
  try {
    for (const name of PROFILE_IMAGES) {
      const temporary = path.join(repoRoot, `${name}.tmp-${id}`);
      staged.set(name, temporary);
      await io.writeFile(temporary, images[name], { encoding: 'utf8', flag: 'wx' });
      if (saved.get(name) !== null) {
        const backup = path.join(repoRoot, `${name}.tmp-${id}-backup`);
        backups.set(name, backup);
        await io.writeFile(backup, saved.get(name), { flag: 'wx' });
      }
    }
    for (const name of PROFILE_IMAGES) {
      await io.rename(staged.get(name), path.join(repoRoot, name));
      replaced.push(name);
    }
  } catch (error) {
    const failures = [];
    for (const name of [...replaced].reverse()) {
      try {
        if (saved.get(name) === null) await io.rm(path.join(repoRoot, name), { force: true });
        else await io.rename(backups.get(name), path.join(repoRoot, name));
      } catch (failure) { failures.push(failure); }
    }
    recoveryFailed = failures.length > 0;
    if (recoveryFailed) throw new AggregateError([error, ...failures], 'Pair replacement/rollback failed; backup files retained');
    throw error;
  } finally {
    for (const temporary of staged.values()) await io.rm(temporary, { force: true });
    if (!recoveryFailed) for (const backup of backups.values()) await io.rm(backup, { force: true });
  }
}

async function generateProfileHeatmaps(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const config = options.localConfig || JSON.parse(await fs.readFile(path.join(repoRoot, '.heatmap-sync.json'), 'utf8'));
  const now = options.now || new Date();
  const timeZone = resolveTimeZone(options.timeZone || config.timeZone || 'local');
  const targetDay = dayKeyInZone(now, timeZone);
  const capturePath = options.profileCapturePath || config.profileCapture || process.env.CCU_PROFILE_CAPTURE;
  const check = { targetDay, timeZone, now, maxAgeMs: MAX_AGE_MS };
  const provided = options.profileCapture || (options.claudeCheckpoint && options.codexCheckpoint
    ? { schemaVersion: 1, claude: options.claudeCheckpoint, codex: options.codexCheckpoint } : undefined);
  if (!provided && !capturePath) {
    throw new Error('Fresh dual-provider numeric export required for paired sync; the old SVG snapshot is not sufficient');
  }
  const { claude, codex: codexData } = provided ? validateProfileCapture(provided, check) : await loadProfileCapture(capturePath, check);
  const codex = { providerDaily: codexData.daily, daily: Object.fromEntries(Object.entries(codexData.daily).map(([day, row]) => [day, row.tokens])),
    dailyCosts: Object.fromEntries(Object.entries(codexData.daily).map(([day, row]) => [day, {
      equivalentUsd: row.amountUSD ?? 0, totalTokens: row.tokens, pricedTokens: row.pricedCount,
    }])) };
  const pair = renderProfilePair(claude, codex, { targetDay, timeZone,
    palette: config.heatmapPalette || 'academicViolet', customAccent: config.heatmapAccent, pluginOut: options.pluginOut, renderer: options.renderer });
  if (!options.previewOnly) await replaceImagePair(repoRoot, pair.images, options.io);
  return { ...pair, claudeMetadata: claude.metadata, codexMetadata: codexData.metadata, warnings: [] };
}

if (require.main === module) generateProfileHeatmaps().then(({ summary }) => console.log(JSON.stringify(summary, null, 2)))
  .catch(error => { console.error(`Paired heatmap update stopped: ${error.message}`); process.exitCode = 1; });

module.exports = { PROFILE_IMAGES, wholeMoney, renderProfilePair, renderCodexFeePreview, replaceImagePair, generateProfileHeatmaps };
