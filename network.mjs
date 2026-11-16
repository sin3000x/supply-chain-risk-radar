import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const modes = {sea:'海运',air:'空运',rail:'铁路',road:'公路',local:'本地'};
const levels = {must:'所有候选路径经过',main:'所有主要路径经过，可查看备选',shared:'部分主要路径经过',alt_only:'仅备选路径经过'};
const types = new Set(['port','airport','chokepoint','sea_area','city']);
const fold = text => String(text ?? '').normalize('NFKC').toLowerCase();
const escape = text => text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

export async function loadNetwork(directory, label) {
  const [nodes, {lanes}] = await Promise.all(['nodes.json','lanes.json'].map(async file =>
    JSON.parse(await readFile(join(directory,file),'utf8'))));
  const byId = new Map(nodes.map(node=>[node.id,node]));
  const index = new Map();
  const origins = new Set(lanes.map(lane=>lane.origin_id));
  const destinations = new Set(lanes.map(lane=>lane.dest_city));
  for (const lane of lanes) for (const [mode,data] of Object.entries(lane.modes)) {
    for (const [id,level] of Object.entries(data.node_exposure)) {
      if (!byId.has(id)) continue;
      if (!index.has(id)) index.set(id,[]);
      const matched = data.paths.filter(path=>path.nodes.includes(id));
      index.get(id).push({
        laneId:lane.lane_id, origin:lane.origin_name, destination:lane.dest_name, mode,
        modeLabel:modes[mode] ?? mode, exposure:level,
        exposureLabel:level === 'shared' && !data.paths.some(path=>path.likelihood === '主要')
          ? '部分候选路径经过（仅有备选路径）' : levels[level] ?? level,
        matchedPathIds:matched.map(path=>path.id), candidatePathCount:data.paths.length,
      });
    }
  }
  const matchers = nodes.filter(node=>types.has(node.type) && index.has(node.id)).map(node=>({
    node, patterns:[node.name_zh,node.name_en,...(node.aliases ?? [])].map(fold).filter(name=>
      name.length >= 2 && (/\p{Script=Han}/u.test(name) || name.length >= 5 && /[a-z]/.test(name))
    ).map(name=>new RegExp(/\p{Script=Han}/u.test(name) ? escape(name) : `\\b${escape(name)}\\b`,'u')),
  }));
  return {
    summary:{label,nodeCount:nodes.length,laneCount:lanes.length,originCount:origins.size,destinationCount:destinations.size},
    annotate(event) {
      if (event.routeRelevant === false) return {...event,networkMatches:[]};
      const mentioned = fold([event.title,event.summary,...event.records.filter(r=>r.role !== 'background').flatMap(r=>event.topic ? [r.title,r.region] : [r.title,r.summary,r.region])].join(' '));
      const explicit = event.geoAnchors?.length > 0;
      const matched = explicit ? event.geoAnchors.map(id=>byId.get(id)).filter(Boolean)
        : matchers.filter(({patterns})=>patterns.some(pattern=>pattern.test(mentioned))).map(({node})=>node);
      const specific = matched.some(node=>node.type !== 'city');
      return {...event,networkMatches:matched.filter(node=>explicit || !specific || node.type !== 'city').map(node=>({
        nodeId:node.id,nodeName:node.name_zh,nodeType:node.type,basis:explicit ? 'event_anchor' : 'place_mention',
        routes:index.get(node.id) ?? [],
      })).filter(match=>match.routes.length)};
    },
  };
}
