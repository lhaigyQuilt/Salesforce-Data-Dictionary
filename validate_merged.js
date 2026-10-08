// Validate the built page before publishing.
//
// The important check is the last one: the explorer (search, filters, merged
// SBU/XBU view) must stay byte-identical to the original in build_dict_html.js,
// which was itself verified byte-for-byte against the published artifact.
const fs = require('fs');
const zlib = require('zlib');
const OUT = __dirname.split(String.fromCharCode(92)).join('/');

const PAGE = OUT + '/salesforce-data-dictionary.html';
if (!fs.existsSync(PAGE)) { console.error('no page at ' + PAGE + ' — run build_dict_html3.js first'); process.exit(1); }
const pg = fs.readFileSync(PAGE, 'utf8');
const bytes = Buffer.byteLength(pg, 'utf8');
let bad = 0;
const fail = m => { console.log('  FAIL  ' + m); bad++; };
const ok = m => console.log('  ok    ' + m);

console.log('page: ' + (bytes / 1048576).toFixed(2) + ' MB');
bytes < 15 * 1024 * 1024 ? ok('under the 15 MB limit') : fail('page exceeds 15 MB');

// ---- payload integrity ----
const TAG = '<script id="payload" type="text/plain">';
const pi = pg.indexOf(TAG), pj = pg.indexOf('</script>', pi);
const b64 = pi < 0 ? '' : pg.slice(pi + TAG.length, pj).trim();
let P = null;
try {
  P = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
  ok('payload gunzips and parses');
} catch (e) { fail('payload does not decode: ' + e.message.slice(0, 90)); }
if (P) {
  const nf = P.orgs.reduce((a, o) => a + o.objs.reduce((x, y) => x + y[3].length, 0), 0);
  console.log('        orgs: ' + P.orgs.map(o => o.id + ' ' + o.objs.length + ' objs').join(', ') + ' | ' + nf + ' fields');
  P.orgs.length === 2 ? ok('both orgs present') : fail('expected 2 orgs, got ' + P.orgs.length);
  nf > 20000 ? ok('field count plausible') : fail('only ' + nf + ' fields — scan likely truncated');
}
/[<>&]/.test(b64) ? fail('base64 contains markup characters') : ok('base64 is clean');

// ---- structure ----
const ids = ['main', 'objlist', 'q', 'stats', 'orgsub', 'fBu', 'fObj', 'mType', 'btnType',
  'popType', 'typeSummary', 'clearAll', 'cbAll', 'themeBtn',
  'changesView', 'appView', 'toDict', 'toChanges', 'themeBtn2', 'payload', 'explorer'];
const dupes = ids.filter(id => (pg.match(new RegExp('id="' + id + '"', 'g')) || []).length !== 1);
dupes.length ? fail('ids missing or duplicated: ' + dupes.join(', ')) : ok('all ' + ids.length + ' element ids present exactly once');
/<div class="app" id="appView" hidden>/.test(pg) ? ok('changes page is the landing view') : fail('app is not hidden at load');
['chNew', 'chChanged', 'chRemoved'].every(id => (pg.match(new RegExp('id="' + id + '"', 'g')) || []).length === 1) &&
  (pg.match(/class="csum"/g) || []).length === 2
  ? ok('changes page: both org summaries and all three change sections rendered')
  : fail('changes page is missing an org summary or a change section');

// ---- theme tokens: nothing may be defined only in a dark block ----
const root = pg.slice(pg.indexOf(':root{'), pg.indexOf('@media (prefers-color-scheme:dark)'));
const defined = new Set([...root.matchAll(/--([a-z0-9-]+)\s*:/g)].map(x => x[1]));
const missing = [...new Set([...pg.matchAll(/var\(--([a-z0-9-]+)\)/g)].map(x => x[1]))].filter(t => !defined.has(t));
missing.length ? fail('CSS tokens undefined on bare :root: ' + missing.join(', ')) : ok('all CSS tokens defined on bare :root');

// ---- the explorer must be unchanged ----
function explorer(s) {
  const i = s.indexOf('(function(){\nconst P=window.P');
  if (i < 0) return null;
  const end = s.indexOf('</script>', i);
  return s.slice(i, s.lastIndexOf('})();', end) + '})();'.length);
}
const src = fs.readFileSync(OUT + '/build_dict_html.js', 'utf8');
let ref = explorer(src);
if (ref) ref = ref.split("\\\\'").join("\\'");   // template literal source -> emitted output
const got = explorer(pg);
if (!ref || !got) fail('could not locate the explorer script in both files');
else if (ref.trim() === got.trim()) ok('explorer byte-identical to build_dict_html.js (' + got.length + ' chars)');
else {
  const a = ref.trim(), b = got.trim();
  let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
  fail('explorer diverges at char ' + k + '\n        expected: ' + JSON.stringify(a.slice(k, k + 70)) +
       '\n        got:      ' + JSON.stringify(b.slice(k, k + 70)));
}

console.log(bad ? '\n' + bad + ' CHECK(S) FAILED' : '\nall checks passed');
process.exit(bad ? 1 : 0);
