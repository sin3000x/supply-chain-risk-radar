"""Fetch public publisher feeds also listed in WorldMonitor's news catalog."""
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import json
from pathlib import Path
from collections import defaultdict
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

FEEDS = json.loads(Path(__file__).with_name("data").joinpath("news-sources.json").read_text(encoding="utf-8"))
LIMIT = 2 * 1024 * 1024


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def parse_feed(contents, feed):
    if b'<!DOCTYPE' in contents.upper() or b'<!ENTITY' in contents.upper():
        raise ValueError("unsupported XML declaration")
    root = ET.fromstring(contents)
    if root.tag != "rss" or root.find("channel") is None:
        raise ValueError("expected an RSS channel")
    records = []
    for item in root.findall("./channel/item")[:30]:
        title, link = [item.findtext(field, "").strip() for field in ("title", "link")]
        if not title or urlsplit(link).scheme not in ("https", "http"):
            continue
        parser = PlainText()
        parser.feed(item.findtext("description", ""))
        source = feed["name"]
        if urlsplit(feed["url"]).hostname == "news.google.com":
            source = (item.findtext("source") or source).strip()
            suffix = " - " + source
            if title.endswith(suffix) and len(title) > len(suffix):
                title = title[:-len(suffix)]
        records.append(dict(title=title, link=link, source=source,
                            feedName=feed["name"], feedCategory=feed["category"],
                            publishedAt=item.findtext("pubDate"),
                            snippet=" ".join(" ".join(parser.parts).split())[:500]))
    return records


def fetch_feed(entry):
    url = entry["url"]
    try:
        request = Request(url, headers={"User-Agent": "ExternalEventDemo/0.1", "Accept": "application/rss+xml, application/xml"})
        with urlopen(request, timeout=6) as response:
            contents = response.read(LIMIT + 1)
        if len(contents) > LIMIT:
            raise ValueError("feed too large")
        return entry, parse_feed(contents, entry), None
    except (ValueError, OSError, ET.ParseError) as error:
        return entry, [], str(error)


if __name__ == "__main__":
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(fetch_feed, FEEDS))
    categories = defaultdict(list)
    sources = []
    for feed, records, error in results:
        categories[feed["category"]].extend(records)
        sources.append({"name": feed["name"], "category": feed["category"],
                        "count": len(records), "error": error})
    print(json.dumps({
        "categories": {category: {"items": records} for category, records in categories.items()},
        "feedStatus": sources,
    }, ensure_ascii=False))
