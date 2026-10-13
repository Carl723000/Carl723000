'use strict';

// Only an explicit producer observation can renew this aggregate. File mtimes,
// rendering dates and copies of an old export are not freshness evidence.
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const TOP_FIELDS = ['schemaVersion', 'provider', 'currency', 'timeZone', 'asOfDay', 'generatedAt',
  'sourceComplete', 'dataRevision', 'pricingRevision', 'claudeBackend', 'daily'];
const DAY_FIELDS = ['tokens', 'amountUSD', 'pricingStatus', 'estimated', 'pricedCount',
  'unpricedCount', 'sourceComplete'];

function fail(message) { throw new Error(`Invalid Claude checkpoint: ${message}`); }

function objectFields(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !expected.includes(key))) fail(`${label} contains unsupported fields`);
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail(`${label} is missing required fields`);
  if (keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail(`${label} contains accessors`);
}

function validDay(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} must be an ISO calendar day`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label} is not a real calendar day`);
  return value;
}

function validZone(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value || value === 'local'
    || /^[+-]/.test(value)) fail(`${label} must be an explicit IANA timezone`);
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date(0)); }
  catch { fail(`${label} is not a supported IANA timezone`); }
  return value;
}

function dateInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const field = type => parts.find(part => part.type === type).value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}

// Match the profile's existing calendar-equivalence policy without importing
// its generator (which consumes this reader). Probe five years around target.
function calendarZonesEquivalent(left, right, targetDay) {
  if (left === right) return true;
  const formatter = zone => new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const a = formatter(left);
  const b = formatter(right);
  const year = Number(targetDay.slice(0, 4));
  for (let probeYear = year - 2; probeYear <= year + 2; probeYear += 1) {
    for (let month = 0; month < 12; month += 1) {
      for (const day of [1, 15, 28]) {
        for (const hour of [0, 6, 12, 18, 23]) {
          for (const minute of [0, 30]) {
            const date = new Date(0);
            date.setUTCFullYear(probeYear, month, day);
            date.setUTCHours(hour, minute, 0, 0);
            if (a.format(date) !== b.format(date)) return false;
          }
        }
      }
    }
  }
  return true;
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative safe integer`);
  return value;
}

function validateClaudeCheckpoint(value, options = {}) {
  const provider = options.provider === 'codex' ? 'codex' : 'claude';
  const expectedFields = provider === 'codex' ? TOP_FIELDS.map(key => key === 'claudeBackend' ? 'currentManifestVerified' : key) : TOP_FIELDS;
  objectFields(value, expectedFields, 'root');
  if (value.schemaVersion !== 1 || value.provider !== provider) fail('unsupported schema or provider');
  if (value.currency !== 'USD') fail('currency must be USD');
  if (value.sourceComplete !== true) fail('source observation must be complete');
  if (provider === 'claude' && !['anthropic', 'aws-bedrock-in-region'].includes(value.claudeBackend)) fail('unsupported Claude pricing backend');
  if (provider === 'codex' && value.currentManifestVerified !== true) fail('Codex manifest must be verified by the producer');
  safeCount(value.dataRevision, 'dataRevision');
  safeCount(value.pricingRevision, 'pricingRevision');
  const targetDay = validDay(options.targetDay, 'targetDay');
  validDay(value.asOfDay, 'asOfDay');
  if (value.asOfDay !== targetDay) fail('asOfDay does not match targetDay');
  const targetZone = validZone(options.timeZone, 'requested timeZone');
  const sourceZone = validZone(value.timeZone, 'timeZone');
  if (!calendarZonesEquivalent(sourceZone, targetZone, targetDay)) fail('calendar timezone mismatch');
  const now = options.now === undefined ? new Date() : new Date(options.now);
  if (!Number.isFinite(now.getTime())) fail('now must be a valid date');
  if (dateInZone(now, targetZone) !== targetDay) fail('targetDay is not the current requested calendar day');
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) fail('maxAgeMs must be nonnegative and finite');
  if (typeof value.generatedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.generatedAt)) fail('generatedAt must be a UTC ISO timestamp');
  const observation = new Date(value.generatedAt);
  const canonical = value.generatedAt.includes('.') ? value.generatedAt : value.generatedAt.replace('Z', '.000Z');
  if (!Number.isFinite(observation.getTime()) || observation.toISOString() !== canonical) fail('generatedAt is not a real ISO timestamp');
  if (dateInZone(observation, sourceZone) !== targetDay) fail('generatedAt is not on targetDay');
  const ageMs = now.getTime() - observation.getTime();
  if (ageMs < -FUTURE_TOLERANCE_MS) fail('generatedAt is in the future');
  if (ageMs > maxAgeMs) fail('producer observation is stale');
  if (!value.daily || typeof value.daily !== 'object' || Array.isArray(value.daily)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value.daily))) fail('daily must be a plain object');
  const dates = Reflect.ownKeys(value.daily);
  if (dates.length > 366) fail('daily exceeds the trailing 366-day limit');
  for (const date of dates) validDay(date, 'daily date');
  const first = new Date(`${targetDay}T00:00:00.000Z`);
  first.setUTCDate(first.getUTCDate() - 365);
  const firstDay = first.toISOString().slice(0, 10);
  const daily = {};
  let tokens = 0;
  let amountUSD = 0;
  let hasAmount = false;
  let pricedCount = 0;
  let unpricedCount = 0;
  for (const date of dates.sort()) {
    validDay(date, 'daily date');
    if (date < firstDay || date > targetDay) fail('daily date is outside the trailing observation window');
    const descriptor = Object.getOwnPropertyDescriptor(value.daily, date);
    if (!Object.hasOwn(descriptor, 'value')) fail('daily contains accessors');
    const row = descriptor.value;
    objectFields(row, DAY_FIELDS, `daily ${date}`);
    const count = safeCount(row.tokens, 'tokens');
    const priced = safeCount(row.pricedCount, 'pricedCount');
    const unpriced = safeCount(row.unpricedCount, 'unpricedCount');
    if (!Number.isSafeInteger(priced + unpriced) || count !== priced + unpriced) fail('token coverage does not match actual tokens');
    if (row.estimated !== (provider === 'claude') || row.sourceComplete !== true) fail('daily estimate/source-complete flags do not match the provider');
    if (row.amountUSD !== null && (typeof row.amountUSD !== 'number' || !Number.isFinite(row.amountUSD) || row.amountUSD < 0 || row.amountUSD > Number.MAX_SAFE_INTEGER)) fail('amountUSD must be bounded nonnegative finite money or null');
    switch (row.pricingStatus) {
      case 'empty':
        if (count !== 0 || row.amountUSD !== null) fail('empty day must have zero tokens and no monetary observation');
        break;
      case 'unpriced':
        if (count === 0 || priced !== 0 || row.amountUSD !== null) fail('unpriced activity must retain tokens and withhold money');
        break;
      case 'partial':
        if (priced === 0 || unpriced === 0 || row.amountUSD === null) fail('partial pricing must have priced and unpriced activity plus a subtotal');
        break;
      case 'complete':
        if (unpriced !== 0 || row.amountUSD === null || (count === 0 && row.amountUSD !== 0)) fail('complete pricing must cover all tokens (a zero-token row has zero money)');
        break;
      default: fail('unsupported pricingStatus');
    }
    tokens = safeCount(tokens + count, 'total tokens');
    pricedCount = safeCount(pricedCount + priced, 'total pricedCount');
    unpricedCount = safeCount(unpricedCount + unpriced, 'total unpricedCount');
    hasAmount ||= row.amountUSD !== null;
    amountUSD += row.amountUSD ?? 0;
    if (!Number.isFinite(amountUSD) || amountUSD > Number.MAX_SAFE_INTEGER) fail('monetary subtotal overflow');
    daily[date] = { tokens: count, amountUSD: row.amountUSD, pricingStatus: row.pricingStatus,
      estimated: provider === 'claude', pricedCount: priced, unpricedCount: unpriced, sourceComplete: true };
  }
  const metadata = { schemaVersion: 1, provider, currency: 'USD', timeZone: sourceZone,
    asOfDay: targetDay, generatedAt: value.generatedAt, sourceComplete: true,
    dataRevision: value.dataRevision, pricingRevision: value.pricingRevision,
    ...(provider === 'claude' ? { claudeBackend: value.claudeBackend } : { currentManifestVerified: true }) };
  return { daily, metadata, stats: { source: `${provider}-checkpoint`, snapshotDay: targetDay,
    asOfDay: targetDay, observedAt: value.generatedAt, sourceComplete: true, cells: dates.length,
    activeDays: Object.values(daily).filter(row => row.tokens > 0).length,
    tokens, amountUSD: hasAmount ? amountUSD : null, pricedCount, unpricedCount,
    pricingComplete: unpricedCount === 0 } };
}

function validateProfileCapture(value, options) {
  objectFields(value, ['schemaVersion', 'claude', 'codex'], 'capture');
  if (value.schemaVersion !== 1) fail('unsupported capture schema');
  const claude = validateClaudeCheckpoint(value.claude, { ...options, provider: 'claude' });
  const codex = validateClaudeCheckpoint(value.codex, { ...options, provider: 'codex' });
  if (claude.metadata.generatedAt !== codex.metadata.generatedAt) fail('capture observations do not match');
  return { claude, codex };
}

async function readCheckpointFile(file, options, validate) {
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CHECKPOINT_BYTES) fail('checkpoint must be a bounded regular file, not a symlink');
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > MAX_CHECKPOINT_BYTES) fail('checkpoint changed while opening');
    const buffer = Buffer.alloc(MAX_CHECKPOINT_BYTES + 1);
    let length = 0;
    for (;;) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      length += result.bytesRead;
      if (length > MAX_CHECKPOINT_BYTES) fail('checkpoint exceeds byte limit');
      if (result.bytesRead === 0) break;
    }
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('checkpoint changed while reading');
    let value;
    try { value = JSON.parse(buffer.subarray(0, length).toString('utf8')); }
    catch { fail('checkpoint is not valid JSON'); }
    return validate(value, options);
  } finally { await handle.close(); }
}

const loadClaudeCheckpoint = (file, options) => readCheckpointFile(file, options, validateClaudeCheckpoint);
const loadProfileCapture = (file, options) => readCheckpointFile(file, options, validateProfileCapture);
module.exports = { DEFAULT_MAX_AGE_MS, MAX_CHECKPOINT_BYTES, validateClaudeCheckpoint, loadClaudeCheckpoint, validateProfileCapture, loadProfileCapture };
