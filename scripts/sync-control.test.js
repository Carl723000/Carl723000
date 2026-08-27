'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_CONFIG,
  normalizeConfig,
  parseTime,
  renderPlist,
  scheduleLabel,
  weekdayNumber,
} = require('./sync-control');

test('default schedule is Sunday at 20:00 Hong Kong time', () => {
  assert.equal(scheduleLabel(DEFAULT_CONFIG), 'Sunday 20:00');
  assert.equal(DEFAULT_CONFIG.timeZone, 'Asia/Hong_Kong');
});

test('schedule parsing accepts names and validates time', () => {
  assert.equal(weekdayNumber('Mon'), 1);
  assert.deepEqual(parseTime('07:05'), { hour: 7, minute: 5 });
  assert.throws(() => parseTime('25:00'), /outside/);
  assert.throws(() => weekdayNumber('holiday'), /Weekday/);
});

test('config rejects an invalid Codex source', () => {
  assert.throws(() => normalizeConfig({ codexSource: 'raw-logs' }), /codexSource/);
});

test('plist contains the weekly schedule and escapes local paths', () => {
  const plist = renderPlist(DEFAULT_CONFIG, {
    nodePath: '/Users/A&B/node',
    syncScript: '/tmp/sync.js',
    repoRoot: '/tmp/profile',
    logPath: '/tmp/out.log',
    errorLogPath: '/tmp/error.log',
  });
  assert.match(plist, /<key>Weekday<\/key>\s*<integer>0<\/integer>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>20<\/integer>/);
  assert.match(plist, /\/Users\/A&amp;B\/node/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
});
