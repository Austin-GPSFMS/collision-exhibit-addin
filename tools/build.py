#!/usr/bin/env python3
"""
Build step for the Collision Telemetry Exhibit add-in.

  python3 tools/build.py

Produces, in the project root:
  exhibit.js                              exhibit.template.js with the GPSFMS logo inlined
  collisionExhibit.standalone.html        single-file page (CSS + JS inlined; CDN libs stay external)
"""
import base64, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

logo_b64 = base64.b64encode(open('assets/gpsfms-logo-primary.png', 'rb').read()).decode()
tpl = open('exhibit.template.js', encoding='utf-8').read()
open('exhibit.js', 'w', encoding='utf-8').write(tpl.replace('__LOGO_B64__', logo_b64))

html = open('collisionExhibit.html', encoding='utf-8').read()
css = open('styles.css', encoding='utf-8').read()
js = ''.join(open(f, encoding='utf-8').read() + '\n' for f in ('analysis.js', 'camera.js', 'exhibit.js', 'collisionExhibit.js'))
standalone = html.replace('<link rel="stylesheet" type="text/css" href="styles.css" />', '<style>\n' + css + '\n</style>')
standalone = re.sub(r'<script src="(analysis|camera|exhibit|collisionExhibit)\.js"></script>\n?', '', standalone)
standalone = standalone.replace('</div>\n<script src="https://cdnjs', '</div>\n<script src="https://cdnjs', 1)
# append the inlined JS after the CDN script tags
# MyGeotab's add-in loader pattern-matches document-level tags in the fetched page; any literal
# <html>/<head>/<body>/<style>/<script>/<title> inside the inlined JS would be taken for page markup.
forbidden = re.findall(r'</?\s*(?:html|head|body|style|script|title)\b', js, flags=re.I)
if forbidden:
    raise SystemExit('refusing to build: inlined JS contains document-level tags %s — hex-escape them (e.g. <\\x62ody>)' % sorted(set(forbidden)))
standalone = standalone.rstrip() + '\n<script>\n' + js + '\n</script>\n'
standalone = '<!DOCTYPE html>\n<html>\n' + standalone.replace('<head>', '<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>Collision Telemetry Exhibit</title>', 1) + '</html>\n'
open('collisionExhibit.standalone.html', 'w', encoding='utf-8').write(standalone)

print('built exhibit.js, collisionExhibit.standalone.html (%d KB)' % (os.path.getsize('collisionExhibit.standalone.html') // 1024))
