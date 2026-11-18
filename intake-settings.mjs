import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const INTAKE_DEFAULTS = Object.freeze({
  googleNewsWindowDays: 0,
  newsMaxAgeHours: 0,
  clusterWindowHours: 48,
  portWatchWindowDays: 7,
  portWatchThresholdPct: 15,
  marketHorizonDays: 0,
  marketMinVolume: 25000,
});

const FIELD_RULES = {
  googleNewsWindowDays: {min: 1, max: 30, allowZero: true, label: 'Google News 抓取时间窗（天）'},
  newsMaxAgeHours: {min: 6, max: 720, allowZero: true, label: '新闻最大保留时长（小时）'},
  clusterWindowHours: {min: 6, max: 336, allowZero: false, label: '事件归并时间窗（小时）'},
  portWatchWindowDays: {min: 3, max: 30, allowZero: false, label: 'PortWatch 对比窗口（天）'},
  portWatchThresholdPct: {min: 5, max: 80, allowZero: false, label: 'PortWatch 异动阈值（%）'},
  marketHorizonDays: {min: 1, max: 730, allowZero: true, label: '预测市场到期上限（天）'},
  marketMinVolume: {min: 1000, max: 5000000, allowZero: false, label: '预测市场最低成交量（美元）'},
};

/** Validate and normalize intake settings into integer config values. */
export function validateIntakeSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Error('请检查采集配置格式。');
  }
  const normalized = {};
  for (const [key, rule] of Object.entries(FIELD_RULES)) {
    const raw = input[key];
    if (raw === undefined) {
      normalized[key] = INTAKE_DEFAULTS[key];
      continue;
    }
    if (raw === null || typeof raw === 'boolean' || (typeof raw === 'string' && !raw.trim())) {
      throw Error(`请输入有效的${rule.label}。`);
    }
    const num = Number(raw);
    if (!Number.isInteger(num)) {
      throw Error(`${rule.label}必须为整数。`);
    }
    const valid = (rule.allowZero && num === 0) || (num >= rule.min && num <= rule.max);
    if (!valid) {
      throw Error(
        rule.allowZero
          ? `${rule.label}需为 0（使用默认/不限制）或 ${rule.min}–${rule.max} 之间的整数。`
          : `${rule.label}需为 ${rule.min}–${rule.max} 之间的整数。`,
      );
    }
    normalized[key] = num;
  }
  return normalized;
}

const isCustomized = settings =>
  Object.keys(INTAKE_DEFAULTS).some(key => settings[key] !== INTAKE_DEFAULTS[key]);

/** Open persisted intake settings from disk with atomic, serialized updates. */
export async function openIntakeSettings(path = process.env.INTAKE_CONFIG_PATH ||
  fileURLToPath(new URL('./var/intake-settings.json', import.meta.url))) {
  let current = {...INTAKE_DEFAULTS};
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'));
    current = validateIntakeSettings(stored?.settings ?? stored);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let queue = Promise.resolve();

  function describe() {
    return {
      settings: {...current},
      defaults: INTAKE_DEFAULTS,
      isCustom: isCustomized(current),
    };
  }

  async function save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw Error('请检查采集配置。');
    }
    let next;
    if (input.action === 'reset') {
      next = {...INTAKE_DEFAULTS};
    } else if (input.action === 'save') {
      next = validateIntakeSettings(input.settings ?? input);
    } else {
      throw Error('不支持的采集配置操作。');
    }

    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), {recursive: true});
    try {
      await writeFile(temporary, JSON.stringify({version: 1, settings: next}, null, 2), {mode: 0o600, flag: 'wx'});
      await rename(temporary, path);
    } finally {
      await rm(temporary, {force: true}).catch(() => {});
    }
    current = next;
    return describe();
  }

  return {
    read: () => ({...current}),
    describe,
    update(input) {
      const result = queue.then(() => save(input));
      queue = result.catch(() => {});
      return result;
    },
  };
}
