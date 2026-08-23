#!/usr/bin/env python3
"""Собрать одностраничник в dist/.

  prod  — данные качаются по ссылке из src/config.json и расшифровываются паролем
  local — данные берутся из tracks.js рядом со страницей, пароля нет
"""
import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'src'


def build(mode, out_dir, title=None, data_url=None, full=False):
    config = json.loads((SRC / 'config.json').read_text())
    page = (SRC / 'template.html').read_text()
    page = page.replace('__TITLE__', title or config.get('title', 'Track Vault'))
    page = page.replace('__STYLES__', (SRC / 'app.css').read_text().rstrip())
    page = page.replace('__MARKUP__', (SRC / 'markup.html').read_text().rstrip())
    page = page.replace('__APP__', (SRC / 'app.js').read_text().rstrip())
    page = page.replace('__FULL__', ' class="tv-full"' if full else '')

    if mode == 'prod':
        url = data_url or config['data_url']
        if not url:
            raise SystemExit('в src/config.json не задан data_url')
        loader = (SRC / 'gate.js').read_text().replace('__DATA_URL__', url)
        page = page.replace('__GATE__', (SRC / 'gate.html').read_text().rstrip())
        page = page.replace('__LOADER__', '<script>\n' + loader.rstrip() + '\n</script>')
    else:
        page = page.replace('__GATE__', '')
        page = page.replace('__LOADER__',
                            '<script src="tracks.js"></script>\n<script>window.__bootMap();</script>')

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'index.html').write_text(page)
    return out_dir / 'index.html'


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--mode', choices=['prod', 'local'], default='prod')
    parser.add_argument('--out', type=Path, default=ROOT / 'dist')
    parser.add_argument('--title')
    parser.add_argument('--data-url', help='перебить ссылку из config.json')
    parser.add_argument('--data-file', type=Path, help='local: положить рядом этот tracks.js')
    parser.add_argument('--full', action='store_true',
                        help='карта на весь экран (для отдельной страницы, не для вставки)')
    args = parser.parse_args()

    path = build(args.mode, args.out, args.title, args.data_url, full=args.full)
    if args.data_file and args.data_file.resolve() != (args.out / 'tracks.js').resolve():
        shutil.copy2(args.data_file, args.out / 'tracks.js')
    size = path.stat().st_size / 1024
    print(f'{path} ({size:.0f} КБ, режим {args.mode})')


if __name__ == '__main__':
    main()
