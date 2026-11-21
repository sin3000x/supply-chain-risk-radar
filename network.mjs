import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const modes = {sea:'海运',air:'空运',rail:'铁路',road:'公路',local:'本地'};
const levels = {must:'所有候选路径经过',main:'所有主要路径经过，可查看备选',shared:'部分主要路径经过',alt_only:'仅备选路径经过'};
const types = new Set(['port','airport','hub_airport','chokepoint','sea_area','city']);
const fold = text => String(text ?? '').normalize('NFKC').toLowerCase();
const escape = text => text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
const AIR_SUBJECT = /\b(airports?|flights?|airspace|ground stop|airline\w*)\b/i;
const SEA_SUBJECT = /\b(ports?|shipping|vessels?|tankers?|maritime|dockworkers?|container\w*)\b/i;
const RAIL_SUBJECT = /\b(railways?|trains?|rail)\b/i;
const AMBIGUOUS_IATA = new Set(['ADD','ALL','AIR','CAN','FOR','MAN','NEW','NOW','OLD','OUT','RUN','SAW','SET','WAR']);

/** Compute node exposure levels ('must'|'main'|'shared'|'alt_only') from candidate paths. */
export function computeNodeExposure(paths) {
  if (!Array.isArray(paths) || !paths.length) return {};
  const mainPaths = paths.filter(path => path.likelihood === '主要');
  const allNodes = new Set(paths.flatMap(path => path.nodes ?? []));
  const out = {};
  for (const id of allNodes) {
    if (paths.every(path => path.nodes?.includes(id))) {
      out[id] = 'must';
      continue;
    }
    if (mainPaths.length > 0) {
      if (mainPaths.every(path => path.nodes?.includes(id))) out[id] = 'main';
      else if (mainPaths.some(path => path.nodes?.includes(id))) out[id] = 'shared';
      else out[id] = 'alt_only';
    } else {
      out[id] = 'shared';
    }
  }
  return out;
}

function allowedModes(event, text) {
  if (event.topic === 'maritime_security') return new Set(['sea']);
  if (event.topic !== 'transport_disruption') return null;
  const matched = [
    AIR_SUBJECT.test(text) && 'air',
    SEA_SUBJECT.test(text) && 'sea',
    RAIL_SUBJECT.test(text) && 'rail',
  ].filter(Boolean);
  return matched.length === 1 ? new Set(matched) : null;
}

export async function loadNetwork(directory, label) {
  const [nodes, {lanes, meta}] = await Promise.all(['nodes.json','lanes.json'].map(async file =>
    JSON.parse(await readFile(join(directory,file),'utf8'))));
  const byId = new Map(nodes.map(node=>[node.id,node]));
  const index = new Map();
  const origins = new Set(lanes.map(lane=>lane.origin_id));
  const destinations = new Set(lanes.map(lane=>lane.dest_city));
  const missingNodes = new Set();
  for (const lane of lanes) for (const [mode,data] of Object.entries(lane.modes ?? {})) {
    const paths = data.paths ?? [];
    for (const path of paths) {
      for (const id of path.nodes ?? []) {
        if (!byId.has(id)) missingNodes.add(id);
      }
    }
    const exposure = paths.length ? computeNodeExposure(paths) : (data.node_exposure ?? {});
    for (const [id,level] of Object.entries(exposure)) {
      if (!byId.has(id)) continue;
      if (!index.has(id)) index.set(id,[]);
      const matched = paths.filter(path=>path.nodes?.includes(id));
      index.get(id).push({
        laneId:lane.lane_id, origin:lane.origin_name, destination:lane.dest_name, mode,
        modeLabel:modes[mode] ?? mode, exposure:level,
        exposureLabel:level === 'shared' && !paths.some(path=>path.likelihood === '主要')
          ? '部分候选路径经过（仅有备选路径）' : levels[level] ?? level,
        matchedPathIds:matched.map(path=>path.id), candidatePathCount:paths.length,
      });
    }
  }
  if (missingNodes.size) {
    console.warn(`Network ${label ?? directory} references unknown nodes: ${[...missingNodes].join(', ')}`);
  }
  function placeMatchers(nodes, minLength) {
    return nodes.map(node => {
      const names = [node.name_zh, node.name_en, ...(node.aliases ?? [])];
      if (/^[A-Z]{5}$/i.test(node.code ?? '')) names.push(node.code);
      const patterns = [...new Set(names.map(fold))].filter(name =>
        name.length >= 2 && (/\p{Script=Han}/u.test(name) || name.length >= minLength && /[a-z]/.test(name))
      ).map(name => new RegExp(/\p{Script=Han}/u.test(name) ? escape(name) : `\\b${escape(name)}\\b`,'u'));

      let iataMatcher = null;
      const code = node.code?.trim();
      if ((node.type === 'airport' || node.type === 'hub_airport') && code && /^[A-Z]{3}$/.test(code)) {
        const parenRx = new RegExp(`\\(${code}\\)`);
        const wordRx = AMBIGUOUS_IATA.has(code)
          ? new RegExp(`\\b(?:${code}\\s+[Aa]irport|[Aa]irport\\s+${code})\\b`)
          : new RegExp(`\\b${code}\\b`);
        iataMatcher = rawText => AIR_SUBJECT.test(rawText) &&
          (parenRx.test(rawText) || (/[a-z]/.test(rawText) && wordRx.test(rawText)));
      }
      return {node, patterns, iataMatcher};
    });
  }
  const locationMatchers = placeMatchers(nodes,4);
  const routeMatchers = placeMatchers(nodes.filter(node=>types.has(node.type) && index.has(node.id)),5);
  function matchPlaces(text, anchors, candidates = routeMatchers) {
    const explicit = anchors?.length > 0;
    const rawText = explicit ? '' : String(text ?? '');
    const mentioned = explicit ? '' : fold(rawText);
    const matched = explicit ? anchors.map(id=>byId.get(id)).filter(Boolean)
      : candidates.filter(({patterns, iataMatcher}) =>
          patterns.some(pattern=>pattern.test(mentioned)) || (iataMatcher && iataMatcher(rawText))
        ).map(({node})=>node);
    const specific = matched.some(node=>node.type !== 'city');
    return {explicit, nodes:matched.filter(node=>explicit || !specific || node.type !== 'city')};
  }
  return {
    snapshot:{nodes,lanes,meta},
    getNode: id => byId.get(id),
    findLocationNodes: text => matchPlaces(text,null,locationMatchers).nodes,
    summary:{label,nodeCount:nodes.length,laneCount:lanes.length,originCount:origins.size,destinationCount:destinations.size},
    /** Network node IDs a single report mentions (title and region only). */
    findPlaces(record) {
      return matchPlaces([record.title,record.region].join(' '),record.geoAnchors).nodes
        .filter(node=>index.has(node.id)).map(node=>node.id);
    },
    annotate(event) {
      if (event.routeRelevant === false) return {...event,networkMatches:[]};
      const text = [event.title,event.summary,event.region,...(event.records ?? []).filter(r=>r.role !== 'background')
        .flatMap(r=>event.topic ? [r.title,r.region] : [r.title,r.summary,r.region])].join(' ');
      const {explicit,nodes} = matchPlaces(text, event.geoAnchors);
      const modeFilter = allowedModes(event, text);
      return {...event,networkMatches:nodes.map(node=>({
        nodeId:node.id,nodeCode:node.code ?? null,nodeName:node.name_zh,nodeType:node.type,basis:explicit ? 'event_anchor' : 'place_mention',
        routes:(index.get(node.id) ?? []).filter(route=>!modeFilter || modeFilter.has(route.mode)),
      })).filter(match=>match.routes.length)};
    },
  };
}
