const WINDOW_MS = 48 * 3600 * 1000;
const stop = new Set('the a an in on at of for to by with and or as is are was were has have after from about over says said'.split(' '));
const terms = text => new Set(String(text ?? '').normalize('NFKC').toLowerCase()
  .match(/[a-z][a-z0-9]*|[0-9]+|\p{Script=Han}{2,}/gu)?.filter(word=>!stop.has(word)) ?? []);
function score(a,b) {
  const common = [...a].filter(word=>b.has(word)).length;
  return {common, similarity: common / (a.size + b.size - common || 1)};
}

export function clusterNews(records, findPlaces) {
  const articles = records.map(record=>({
    record,
    at:Date.parse(record.time.value),
    headline:terms(record.title),
    summary:terms(record.summary),
    places:new Set(findPlaces(record)),
  })).sort((a,b)=> a.at - b.at || a.record.id.localeCompare(b.record.id));
  const groups = [];
  for (const article of articles) {
    const group = groups.find(items=>items.every(other=>{
      if (!Number.isFinite(article.at) || !Number.isFinite(other.at) ||
          Math.abs(article.at - other.at) > WINDOW_MS) return false;
      if (article.places.size && other.places.size && !score(article.places,other.places).common) return false;
      const title = score(article.headline,other.headline);
      if (title.common >= 4 && title.similarity >= .75) return true;
      return score(article.places,other.places).common > 0 &&
        title.common >= 4 && title.similarity >= .5 && score(article.summary,other.summary).similarity >= .55;
    }));
    if (group) group.push(article); else groups.push([article]);
  }
  return groups.map(group=>group.map(item=>item.record));
}
