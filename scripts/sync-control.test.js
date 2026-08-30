'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_CONFIG,
  normalizeConfig,
  parseTime,
  renderPlist,
  resolveTimeZone,
  scheduleLabel,
  systemTimeZone,
  weekdayNumber,
  weekdayNumbers,
} = require('./sync-control');

test('default schedule is Monday and Friday at 20:00 local time', () => {
  assert.equal(scheduleLabel(DEFAULT_CONFIG), 'Monday + Friday 20:00');
  assert.deepEqual(DEFAULT_CONFIG.weekdays, [1, 5]);
  assert.equal(DEFAULT_CONFIG.timeZone, 'local');
  assert.equal(DEFAULT_CONFIG.codexSource, 'ccu-index');
  assert.equal(resolveTimeZone('local'), systemTimeZone());
});

test('schedule parsing accepts names and validates time', () => {
  assert.equal(weekdayNumber('Mon'), 1);
  assert.deepEqual(weekdayNumbers('Fri,Mon,Mon'), [1, 5]);
  assert.deepEqual(normalizeConfig({ weekday: 0 }).weekdays, [0]);
  assert.deepEqual(parseTime('07:05'), { hour: 7, minute: 5 });
  assert.throws(() => parseTime('25:00'), /outside/);
  assert.throws(() => weekdayNumber('holiday'), /Weekday/);
  assert.throws(() => weekdayNumbers(''), /weekday/i);
});

test('config rejects an invalid Codex source', () => {
  assert.throws(() => normalizeConfig({ codexSource: 'raw-logs' }), /codexSource/);
  assert.throws(() => normalizeConfig({ claudeSnapshot: '  ' }), /claudeSnapshot/);
});

test('plist contains both calendar triggers and escapes local paths', () => {
  const plist = renderPlist(DEFAULT_CONFIG, {
    nodePath: '/Users/A&B/node',
    syncScript: '/tmp/sync.js',
    repoRoot: '/tmp/profile',
    logPath: '/tmp/out.log',
    errorLogPath: '/tmp/error.log',
  });
  assert.match(plist, /<key>StartCalendarInterval<\/key>\s*<array>/);
  assert.equal((plist.match(/<key>Weekday<\/key>/g) || []).length, 2);
  assert.match(plist, /<key>Weekday<\/key>\s*<integer>1<\/integer>\s*<key>Hour<\/key>\s*<integer>20<\/integer>/);
  assert.match(plist, /<key>Weekday<\/key>\s*<integer>5<\/integer>\s*<key>Hour<\/key>\s*<integer>20<\/integer>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>20<\/integer>/);
  assert.match(plist, /\/Users\/A&amp;B\/node/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
});
