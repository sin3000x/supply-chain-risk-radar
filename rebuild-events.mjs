import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildEvents} from './events.mjs';
import {openEventStore} from './event-store.mjs';
import {openIntakeSettings} from './intake-settings.mjs';
import {loadNetwork} from './network.mjs';

const utcStamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function extractWmoCountryFromRecord(record) {
  const candidates = [record.source?.url, record.raw?.capURL, record.raw?.url];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const match = raw.match(/(?:severeweather\.wmo\.int\/|^\/?)([a-z]{2})-/i);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/**
 * Losslessly rebuild an existing event store using the current clustering, signal/forecast
 * matching, and WMO geography rules while backing up the prior file and keeping grounded titles.
 */
export async function rebuildEventStore({
  storePath = process.env.EVENT_STORE_PATH || fileURLToPath(new URL('./var/events.json', import.meta.url)),
  networkDir = process.env.RISK_NETWORK_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)),
  intakeConfigPath,
} = {}) {
  let raw;
  try {
    raw = await readFile(storePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {skipped: true, storePath};
    throw error;
  }

  const backup = JSON.parse(raw);
  if (backup?.version !== 1 || !Array.isArray(backup.events)) {
    throw new Error(`Unsupported event store format: ${storePath}`);
  }

  const network = await loadNetwork(networkDir, process.env.RISK_NETWORK_DATA_DIR ? '自定义线路数据' : 'risk_network 默认线路');
  const findPlaces = record => network.findPlaces(record);
  const intake = await openIntakeSettings(intakeConfigPath);
  const clusterWindowMs = intake.read().clusterWindowHours * 3600_000;

  const baseName = basename(storePath, '.json');
  const backupPath = join(dirname(storePath), `${baseName}.before-rebuild.${utcStamp()}.json`);
  await writeFile(backupPath, raw, {mode: 0o600});

  const newsMap = new Map();
  const signalMap = new Map();
  const forecastMap = new Map();
  const oldPresByAnchor = new Map();

  let beforeActive = 0;
  for (const event of backup.events) {
    if (event.mergedInto) continue;
    beforeActive++;
    const oldNewsReports = (event.records ?? []).filter(r => r.kind === 'news' && r.role !== 'background');
    if (event.presentation?.title) {
      const anchorId = event.presentation.titleEvidence?.recordId || oldNewsReports[0]?.id;
      if (anchorId) {
        oldPresByAnchor.set(anchorId, {
          presentation: event.presentation,
          reportIds: new Set(oldNewsReports.map(r => r.id)),
        });
      }
    }
    for (const record of event.records ?? []) {
      if (record.kind === 'news') {
        const {role, ...clean} = record;
        if (!newsMap.has(record.id) || role === 'report') newsMap.set(record.id, clean);
      } else if (record.kind === 'signal') {
        if (record.id?.startsWith('signal:wmo:')) {
          const alertCountry = extractWmoCountryFromRecord(record);
          let places = record.geoAnchors ?? [];
          if (alertCountry) {
            places = places.filter(nodeId => {
              const node = network.getNode(nodeId);
              if (!node) return true;
              if (node.country) return node.country.toUpperCase() === alertCountry;
              return node.type !== 'sea_area';
            });
          }
          if (!places.length) continue;
          signalMap.set(record.id, {...record, geoAnchors: places});
        } else {
          signalMap.set(record.id, record);
        }
      } else if (record.kind === 'forecast') {
        forecastMap.set(record.id, record);
      }
    }
  }

  const built = buildEvents([
    {kind: 'news', records: [...newsMap.values()]},
    {kind: 'signal', records: [...signalMap.values()]},
    {kind: 'forecast', records: [...forecastMap.values()]},
  ], 'live', findPlaces, {clusterWindowMs});

  const tempPath = `${storePath}.rebuild-${randomUUID()}.tmp`;
  let afterActive = 0;
  let restoredFull = 0;
  let restoredTitleOnly = 0;
  try {
    if (built.length) {
      const store = await openEventStore(tempPath, findPlaces, {getWindowMs: () => clusterWindowMs});
      const storedEvents = await store.update(built);
      afterActive = storedEvents.length;

      for (const event of storedEvents) {
        const reports = (event.records ?? []).filter(r => r.kind === 'news' && r.role !== 'background');
        const anchorId = reports[0]?.id;
        if (!anchorId) continue;
        const cached = oldPresByAnchor.get(anchorId);
        if (!cached) continue;
        const {presentation, reportIds} = cached;
        if (presentation.titleEvidence?.recordId && presentation.titleEvidence.recordId !== anchorId) continue;
        const sameReports = reportIds.size === reports.length && reports.every(r => reportIds.has(r.id));
        await store.setPresentation(event.id, () => {
          if (sameReports) {
            restoredFull++;
            return presentation;
          }
          restoredTitleOnly++;
          return {
            title: presentation.title,
            titleEvidence: presentation.titleEvidence,
            ...(presentation.model && {model: presentation.model}),
            update: null,
          };
        });
      }
    } else {
      await writeFile(tempPath, JSON.stringify({version: 1, events: []}), {mode: 0o600});
    }
    await rename(tempPath, storePath);
  } finally {
    await rm(tempPath, {force: true}).catch(() => {});
  }

  return {
    skipped: false,
    storePath,
    backupPath,
    beforeActive,
    afterActive,
    restoredFull,
    restoredTitleOnly,
  };
}

const isCli = () => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isCli()) {
  const result = await rebuildEventStore();
  if (result.skipped) {
    console.log(`未找到事件库 ${result.storePath}，无需重建。`);
  } else {
    console.log(
      `事件库已无损重建：活跃事件 ${result.beforeActive} -> ${result.afterActive}，` +
      `保留完整中文展示 ${result.restoredFull} 条、仅保留标题 ${result.restoredTitleOnly} 条；` +
      `原库已备份至 ${result.backupPath}`,
    );
  }
}
