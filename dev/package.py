"""Build the extension zip for GitHub releases and the Chrome Web Store.

Usage: python dev/package.py
Writes dist/note-names-for-musescore-<version>.zip
"""
import json
import os
import zipfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
INCLUDE = ['manifest.json', 'LICENSE', 'icons', 'popup', 'src']

version = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))['version']
os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
out = os.path.join(ROOT, 'dist', f'note-names-for-musescore-{version}.zip')

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for item in INCLUDE:
        path = os.path.join(ROOT, item)
        if os.path.isfile(path):
            z.write(path, item)
            continue
        for folder, _, files in os.walk(path):
            for f in sorted(files):
                full = os.path.join(folder, f)
                z.write(full, os.path.relpath(full, ROOT).replace(os.sep, '/'))

print(out)
