"""Fetch public publisher feeds also listed in WorldMonitor's news catalog."""
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import json
import sys
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

FEEDS = {
    "BBC World": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "The Guardian": "https://www.theguardian.com/world/rss",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
}
LIMIT = 2 * 1024 * 1024


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def parse_feed(contents, publisher):
    if b'<!DOCTYPE' in contents.upper() or b'<!ENTITY' in contents.upper():
        raise ValueError("unsupported XML declaration")
    root = ET.fromstring(contents)
    records = []
    for item in root.findall("./channel/item")[:30]:
        title, link = [item.findtext(field, "").strip() for field in ("title", "link")]
        if not title or urlsplit(link).scheme not in ("https", "http"):
            continue
        parser = PlainText()
        parser.feed(item.findtext("description", ""))
        records.append(dict(title=title, link=link, source=publisher,
                            publishedAt=item.findtext("pubDate"),
                            snippet=" ".join(" ".join(parser.parts).split())[:500]))
    return records


def fetch_feed(entry):
    publisher, url = entry
    try:
        request = Request(url, headers={"User-Agent": "ExternalEventDemo/0.1", "Accept": "application/rss+xml, application/xml"})
        with urlopen(request, timeout=6) as response:
            contents = response.read(LIMIT + 1)
        if len(contents) > LIMIT:
            raise ValueError("feed too large")
        return publisher, parse_feed(contents, publisher), None
    except (ValueError, OSError, ET.ParseError) as error:
        return publisher, [], str(error)


if __name__ == "__main__":
    with ThreadPoolExecutor(max_workers=len(FEEDS)) as pool:
        results = list(pool.map(fetch_feed, FEEDS.items()))
    print(json.dumps({
        "categories": {"world": {"items": [item for _, items, _ in results for item in items]}},
        "errors": {name: error for name, _, error in results if error},
    }, ensure_ascii=False))
