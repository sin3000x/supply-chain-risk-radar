import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {INTAKE_DEFAULTS, openIntakeSettings, validateIntakeSettings} from './intake-settings.mjs';

test('validateIntakeSettings normalizes integers and rejects invalid values', () => {
  const valid = validateIntakeSettings({
    googleNewsWindowDays: '5',
    newsMaxAgeHours: 24,
    clusterWindowHours: 72,
    portWatchWindowDays: 5,
    portWatchThresholdPct: 20,
    marketHorizonDays: 60,
    marketMinVolume: 50000,
  });
  assert.deepEqual(valid, {
    googleNewsWindowDays: 5,
    newsMaxAgeHours: 24,
    clusterWindowHours: 72,
    portWatchWindowDays: 5,
    portWatchThresholdPct: 20,
    marketHorizonDays: 60,
    marketMinVolume: 50000,
  });

  assert.throws(() => validateIntakeSettings({clusterWindowHours: 2}), /事件归并时间窗/);
  assert.throws(() => validateIntakeSettings({googleNewsWindowDays: 1.5}), /整数/);
  assert.throws(() => validateIntakeSettings({marketMinVolume: ''}), /最低成交量/);
});

test('openIntakeSettings persists custom settings, survives reopen, and resets to defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'intake-settings-'));
  const path = join(dir, 'intake-settings.json');
  try {
    const store1 = await openIntakeSettings(path);
    assert.deepEqual(store1.read(), INTAKE_DEFAULTS);
    assert.equal(store1.describe().isCustom, false);

    const saved = await store1.update({
      action: 'save',
      settings: {...INTAKE_DEFAULTS, googleNewsWindowDays: 7, clusterWindowHours: 96},
    });
    assert.equal(saved.isCustom, true);
    assert.equal(saved.settings.googleNewsWindowDays, 7);
    assert.equal(saved.settings.clusterWindowHours, 96);

    const store2 = await openIntakeSettings(path);
    assert.equal(store2.describe().isCustom, true);
    assert.equal(store2.read().googleNewsWindowDays, 7);
    assert.equal(store2.read().clusterWindowHours, 96);

    const reset = await store2.update({action: 'reset'});
    assert.equal(reset.isCustom, false);
    assert.deepEqual(reset.settings, INTAKE_DEFAULTS);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
