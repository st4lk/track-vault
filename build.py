#!/usr/bin/env python3
"""Assemble the single-file page into dist/.

  prod  - data is downloaded from the URL in src/config.json and decrypted with a password
  local - data is read from tracks.js sitting next to the page, no password
"""
import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'src'


def build(mode, out_dir, title=None, data_url=None, full=False, fragment=False, name='index.html'):
    config = json.loads((SRC / 'config.json').read_text())
    page = (SRC / ('fragment.html' if fragment else 'template.html')).read_text()
    page = page.replace('__TITLE__', title or config.get('title', 'Track Vault'))
    page = page.replace('__STYLES__', (SRC / 'app.css').read_text().rstrip())
    page = page.replace('__MARKUP__', (SRC / 'markup.html').read_text().rstrip())
    app = (SRC / 'app.js').read_text().rstrip()
    app = app.replace('/* __WEATHER__ */', (SRC / 'weather.js').read_text().rstrip())
    page = page.replace('__APP__', app)
    page = page.replace('__FULL__', ' class="tv-full"' if full else '')

    if mode == 'prod':
        url = data_url or config['data_url']
        if not url:
            raise SystemExit('data_url is not set in src/config.json')
        loader = (SRC / 'gate.js').read_text().replace('__DATA_URL__', url)
        page = page.replace('__GATE__', (SRC / 'gate.html').read_text().rstrip())
        page = page.replace('__LOADER__', '<script>\n' + loader.rstrip() + '\n</script>')
    else:
        page = page.replace('__GATE__', '')
        page = page.replace('__LOADER__',
                            '<script src="tracks.js"></script>\n<script>window.__bootMap();</script>')

    if fragment:
        # kramdown wraps stray lines in <p>, so no blank lines may survive
        page = '\n'.join(line for line in page.splitlines() if line.strip())
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / name).write_text(page)
    return out_dir / name


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--mode', choices=['prod', 'local'], default='prod')
    parser.add_argument('--out', type=Path, default=ROOT / 'dist')
    parser.add_argument('--title')
    parser.add_argument('--data-url', help='override the URL from config.json')
    parser.add_argument('--data-file', type=Path, help='local: copy this tracks.js next to the page')
    parser.add_argument('--full', action='store_true',
                        help='map fills the screen (for a standalone page, not for embedding)')
    parser.add_argument('--standalone', action='store_true',
                        help='prod: build a whole page instead of a fragment to embed')
    args = parser.parse_args()

    fragment = args.mode == 'prod' and not args.standalone
    path = build(args.mode, args.out, args.title, args.data_url, full=args.full, fragment=fragment)
    if args.data_file and args.data_file.resolve() != (args.out / 'tracks.js').resolve():
        shutil.copy2(args.data_file, args.out / 'tracks.js')
    size = path.stat().st_size / 1024
    kind = 'fragment to embed' if fragment else 'standalone page'
    print(f'{path} ({size:.0f} KB, mode {args.mode}, {kind})')


if __name__ == '__main__':
    main()
