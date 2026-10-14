#!/usr/bin/env python3
"""
Build step for the Collision Telemetry Exhibit add-in.

  python3 tools/build.py

Produces, in the project root:
  exhibit.js                              exhibit.template.js with the GPSFMS logo inlined
  collisionExhibit.standalone.html        single-file page (CSS + JS inlined; CDN libs stay external)
  config.packed.json                      upload-and-go manifest with all files base64-inlined
"""
import base64, json, os, re

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
standalone = standalone.rstrip() + '\n<script>\n' + js.replace('</script>', '<\\/script>') + '\n</script>\n'
standalone = '<!DOCTYPE html>\n<html>\n' + standalone.replace('<head>', '<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>Collision Telemetry Exhibit</title>', 1) + '</html>\n'
open('collisionExhibit.standalone.html', 'w', encoding='utf-8').write(standalone)

cfg = json.load(open('config.json', encoding='utf-8'))
def data_uri(path, mime):
    return f'data:{mime};base64,' + base64.b64encode(open(path, 'rb').read()).decode()
packed = dict(cfg)
packed['files'] = {
    'collisionExhibit.html': data_uri('collisionExhibit.html', 'text/html'),
    'collisionExhibit.js': data_uri('collisionExhibit.js', 'text/javascript'),
    'analysis.js': data_uri('analysis.js', 'text/javascript'),
    'camera.js': data_uri('camera.js', 'text/javascript'),
    'exhibit.js': data_uri('exhibit.js', 'text/javascript'),
    'styles.css': data_uri('styles.css', 'text/css'),
}
json.dump(packed, open('config.packed.json', 'w', encoding='utf-8'), indent=2)
print('built exhibit.js, collisionExhibit.standalone.html (%d KB), config.packed.json (%d KB)' % (
    os.path.getsize('collisionExhibit.standalone.html') // 1024, os.path.getsize('config.packed.json') // 1024))
