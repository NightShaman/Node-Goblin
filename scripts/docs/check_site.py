#!/usr/bin/env python3
"""Check every local HTML link, fragment and asset in a built MkDocs site."""
import argparse
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.links = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get('id'):
            self.ids.add(attrs['id'])
        if tag == 'a' and attrs.get('name'):
            self.ids.add(attrs['name'])
        for attr in ('href', 'src'):
            value = attrs.get(attr)
            if value:
                self.links.append((tag, value))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', nargs='?', default='site')
    parser.add_argument('--base-path', default='/Node-Goblin/')
    args = parser.parse_args()
    root = Path(args.site).resolve()
    pages = {}
    for path in root.rglob('*.html'):
        page = Page()
        page.feed(path.read_text(encoding='utf-8'))
        pages[path] = page
    errors, checked = [], 0
    if not pages:
        raise SystemExit(f'No HTML found in {root}; run mkdocs build first')
    for source, page in pages.items():
        for tag, raw in page.links:
            url = urlsplit(raw)
            if url.scheme or url.netloc or raw.startswith(('mailto:', 'tel:', 'data:')):
                continue
            path = unquote(url.path)
            if path.startswith('/'):
                if not path.startswith(args.base_path):
                    errors.append(f'{source.relative_to(root)}: outside site base: {raw}')
                    continue
                target = root / path[len(args.base_path):]
            else:
                target = (source.parent / path) if path else source
            target = target.resolve()
            if not target.is_relative_to(root):
                errors.append(f'{source.relative_to(root)}: escapes site: {raw}')
                continue
            if target.is_dir():
                target /= 'index.html'
            checked += 1
            if not target.exists():
                errors.append(f'{source.relative_to(root)}: missing target: {raw}')
            elif tag == 'a' and url.fragment and target in pages:
                fragment = unquote(url.fragment)
                if fragment not in pages[target].ids:
                    errors.append(f'{source.relative_to(root)}: missing fragment: {raw}')
    if errors:
        raise SystemExit('\n'.join(errors))
    print(f'PASS: {len(pages)} HTML pages; {checked} internal links/assets; no missing targets or fragments')

if __name__ == '__main__':
    main()
