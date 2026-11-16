import {classifyByKeyword} from './vendor/worldmonitor/threat-keyword-classifier.ts';
import {normalizeArticleUrl} from './vendor/worldmonitor/article-identity.js';
export const feeds = {
  news: 'news/v1/list-feed-digest?variant=full&lang=en',
  signal: 'intelligence/v1/list-cross-source-signals',
  forecast: 'forecast/v1/get-forecasts',
};

function time(value) {
  if (!value) return null;
  const d = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
  return Number.isFinite(+d) ? d.toISOString() : null;
}
export function normalize(kind, payload) {
  const source = kind === 'news' ? Object.values(payload.categories ?? {}).flatMap(bucket => bucket.items ?? [])
    : kind === 'signal' ? payload.signals : payload.forecasts;
  const seen = new Set();
  return (source ?? []).flatMap(raw => {
    const upstreamId = kind === 'news' ? raw.link : raw.id;
    const title = kind === 'signal' ? raw.summary : raw.title;
    // One article can arrive through several regional feeds or with tracking parameters.
    const identity = kind === 'news' ? normalizeArticleUrl(upstreamId) || upstreamId : upstreamId;
    if (!upstreamId || !title || seen.has(identity)) return [];
    seen.add(identity);
    const classification = kind === 'news' ? raw.threat ?? classifyByKeyword(title) : null;
    return [{
      id: `worldmonitor:${kind}:${upstreamId}`,
      kind, title,
      summary: kind === 'news' ? raw.snippet : kind === 'forecast' ? raw.scenario || raw.feedSummary : null,
      region: raw.region || raw.theater || raw.locationName || null,
      category: raw.domain || classification?.category || raw.type || null,
      classification,
      time: { kind: {news:'published',signal:'detected',forecast:'updated'}[kind], value:time(raw.publishedAt ?? raw.detectedAt ?? raw.updatedAt) },
      source: { provider:'WorldMonitor', endpoint:feeds[kind].split('?')[0], upstreamId, publisher:raw.source || null, url:raw.link || null },
      evidence: kind === 'forecast'
        ? { supporting:raw.caseFile?.supportingEvidence ?? [], counter:raw.caseFile?.counterEvidence ?? [], triggers:raw.caseFile?.triggers ?? [] }
        : kind === 'news' ? { publisherCount: raw.storyMeta?.sourceCount ?? null } : { contributingTypes:raw.contributingTypes ?? [] },
      forecast: kind === 'forecast' ? {
        probability:raw.probability ?? null, priorProbability:raw.priorProbability ?? null,
        confidence:raw.confidence ?? null, horizon:raw.timeHorizon || null, direction:raw.trend || null,
        change:raw.caseFile?.changeSummary || null, resolution:raw.resolution ?? null,
      } : null,
      raw,
    }];
  });
}
