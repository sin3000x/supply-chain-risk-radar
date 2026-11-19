const headlineKey = title => title.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ');

/** News reports of an event in publication order: the first is the event's anchor. */
export const eventReports = event => (event.records ?? [])
  .filter(record => record.kind === 'news' && record.role === 'report' && record.title?.trim())
  .sort((a,b) => (a.time.value ?? '').localeCompare(b.time.value ?? '') || a.id.localeCompare(b.id));

// Select from the full event history, so a report dropping off RSS cannot rename its event.
// The stored model presentation is internal bookkeeping; `applyPresentation` exposes its result.
export function presentEvent({presentation, ...event}) {
  const reports = eventReports(event);
  if (!reports.length) return event;

  const first = reports[0];
  const latest = reports.at(-1);
  const display = {...event,displayTitle:first.title};
  if (headlineKey(first.title) !== headlineKey(latest.title)) {
    display.latestUpdate = {text:latest.title,recordId:latest.id,reportedAt:latest.time.value};
  }
  return display;
}

/** Event-level Chinese title and progress written by the model, when available. */
export function applyPresentation(display, presentation) {
  if (!presentation?.title) return display;
  const result = {...display,displayTitle:presentation.title,titleEvidence:presentation.titleEvidence};
  if (presentation.update) {
    result.latestUpdate = {kind:'progress',...presentation.update};
  } else if (result.latestUpdate?.recordId && Array.isArray(presentation.processedIds) &&
    presentation.processedIds.includes(result.latestUpdate.recordId)) {
    delete result.latestUpdate;
  }
  return result;
}
