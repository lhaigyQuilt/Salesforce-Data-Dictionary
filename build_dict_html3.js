const fs = require('fs');
const OUT = __dirname.split(String.fromCharCode(92)).join('/');
// stable output dir; the old value pointed at a since-deleted session scratchpad
const SC = process.argv[2] || OUT;

const zlib = require('zlib');
// The field payload ships gzipped + base64'd and is inflated in the browser. The
// explorer script below is then executed verbatim, byte-for-byte as it was, once
// window.P exists — nothing about its search behaviour changes.
const packedB64 = zlib.gzipSync(fs.readFileSync(`${OUT}/packed.json`), { level: 9 }).toString('base64');

// ---- changes landing page (the explorer below is untouched) ----
// Written for people who use the dictionary, not for whoever runs the refresh: it leads
// with what actually changed in Salesforce, speaks in field labels and Setup type names,
// and folds scan artefacts (newly visible fields, coverage changes) into closed sections.
const CH = JSON.parse(fs.readFileSync(`${OUT}/changes.json`, 'utf8'));
const PREV = CH.prevDate, GEN = CH.genDate;
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nf = n => n.toLocaleString('en-US');
const plural = (n, one, many) => nf(n) + ' ' + (n === 1 ? one : (many || one + 's'));
const niceDate = d => {
  const t = Date.parse(d);
  return isNaN(t) ? String(d || 'unknown')
    : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

// Object labels, lengths and formula flags come from the current snapshot.
const SNAP = {};
for (const id of ['sbu', 'xbu']) {
  const objs = new Map(), flds = new Map();
  for (const o of JSON.parse(fs.readFileSync(`${OUT}/${id}_data.json`, 'utf8'))) {
    objs.set(o.api, o.label);
    for (const f of o.fields) flds.set(o.api + '.' + f.name, f);
  }
  SNAP[id] = { objs, flds };
}
const objLabel = api => SNAP.sbu.objs.get(api) || SNAP.xbu.objs.get(api) || api;
// Deleted fields only exist in the previous snapshot (staged in .prev/ by refresh_dict.cmd).
const PREVSNAP = {};
for (const id of ['sbu', 'xbu']) {
  const flds = new Map(), p = `${OUT}/.prev/${id}_data.json`;
  if (fs.existsSync(p)) for (const o of JSON.parse(fs.readFileSync(p, 'utf8'))) for (const f of o.fields) flds.set(o.api + '.' + f.name, f);
  PREVSNAP[id] = flds;
}

// Same names the dictionary uses (friendlyType in the explorer).
const TYPE_NAME = { string: 'Text', textarea: 'Text Area', reference: 'Lookup', boolean: 'Checkbox', picklist: 'Picklist',
  multipicklist: 'Multi-Select Picklist', combobox: 'Picklist (editable)', double: 'Number', int: 'Number', long: 'Number',
  currency: 'Currency', percent: 'Percent', datetime: 'Date/Time', date: 'Date', time: 'Time', id: 'Record ID', url: 'URL',
  phone: 'Phone', email: 'Email', address: 'Address', location: 'Geolocation', encryptedstring: 'Text (Encrypted)', base64: 'File' };
const KIND_NAME = { autonumber: 'Auto Number', masterdetail: 'Master-Detail', externallookup: 'External Lookup',
  indirectlookup: 'Indirect Lookup', richtext: 'Rich Text Area' };
function friendlyType(type, f) {
  const t = String(type || '').toLowerCase();
  let n = TYPE_NAME[t] || type || '—';
  if (f && KIND_NAME[f.kind]) return KIND_NAME[f.kind];
  if (t === 'textarea' && f && Number(f.len) > 255) n = 'Long Text Area';
  if (f && f.kind === 'rollup') return 'Roll-Up Summary (' + n + ')';
  if (f && f.formula) return 'Formula (' + n + ')';
  if (f && (t === 'string' || t === 'textarea' || t === 'encryptedstring') && Number(f.len)) n += ' (' + nf(Number(f.len)) + ')';
  return n;
}

// One row per object.field, remembering which org(s) it appeared in.
function merge(kind) {
  const m = new Map();
  for (const id of ['sbu', 'xbu']) for (const f of CH[id][kind]) {
    const k = f.obj + '.' + f.field;
    if (!m.has(k)) m.set(k, Object.assign({}, f, { orgs: [], byOrg: {} }));
    const e = m.get(k); e.orgs.push(id); e.byOrg[id] = f;
  }
  return [...m.values()];
}
const orgBadge = orgs => orgs.length > 1
  ? '<span class="orgtag both" title="In both SBU and XBU">Both</span>'
  : '<span class="orgtag ' + orgs[0] + '">' + orgs[0].toUpperCase() + '</span>';

function byObject(rows, rowHtml) {
  const g = new Map();
  for (const r of rows) { if (!g.has(r.obj)) g.set(r.obj, []); g.get(r.obj).push(r); }
  return [...g.keys()].sort((a, b) => objLabel(a).localeCompare(objLabel(b))).map(obj => {
    const list = g.get(obj).sort((a, b) => (a.label || a.field).localeCompare(b.label || b.field));
    return '<div class="cobj"><div class="cobj-h"><b>' + esc(objLabel(obj)) + '</b>' +
      (objLabel(obj) !== obj ? '<code>' + esc(obj) + '</code>' : '') +
      '<span class="cn">' + plural(list.length, 'field') + '</span></div>' +
      '<ul class="clist">' + list.map(rowHtml).join('') + '</ul></div>';
  }).join('');
}
// data-* attributes the changes-page filters (Org / Change / Object) read
const rowAttrs = (orgs, obj) => ' data-orgs="' + orgs.join(' ') + '" data-obj="' + esc(obj) + '"';
const li = (r, inner) => '<li' + rowAttrs(r.orgs, r.obj) + '>' + inner + '</li>';
const NOMATCH = '<p class="cnone cfnone" hidden>Nothing here matches the filters.</p>';
// Description from the change row, else whichever snapshot still holds the field.
function descOf(r) {
  for (const id of r.orgs) {
    const f = SNAP[id].flds.get(r.obj + '.' + r.field) || PREVSNAP[id].get(r.obj + '.' + r.field);
    const d = r.byOrg[id].desc || (f && f.desc);
    if (d) return '<div class="cdesc">' + esc(d) + '</div>';
  }
  return '';
}
const viewBtn = r => '<button class="cview" type="button" data-obj="' + esc(r.obj) + '" data-field="' + esc(r.field) +
  '" data-label="' + esc(r.label || '') + '">View in dictionary</button>';
const fieldHead = (r, type) => orgBadge(r.orgs) + '<span class="cfl">' + esc(r.label || r.field) + '</span>' +
  '<code class="capi">' + esc(r.field) + '</code>' + (type ? '<span class="cty">' + esc(type) + '</span>' : '');
const snapField = r => SNAP[r.orgs[0]].flds.get(r.obj + '.' + r.field);

// New fields: created since the previous scan. Fields that merely became visible are separated out.
const added = merge('fAdded');
const isNew = r => r.orgs.some(id => r.byOrg[id].newInWindow !== false);
const newF = added.filter(isNew), visibleF = added.filter(r => !isNew(r));
const createdOn = r => {
  const ds = [...new Set(r.orgs.map(id => r.byOrg[id].created).filter(Boolean))];
  return ds.length ? 'created ' + ds.map(niceDate).join(' / ') : '';
};
const newHTML = newF.length
  ? byObject(newF, r => li(r, fieldHead(r, friendlyType(r.type, snapField(r))) +
      '<span class="cwhen">' + esc(createdOn(r)) + '</span>' + viewBtn(r) + descOf(r)))
  : '<p class="cnone">No new fields were created.</p>';

const removed = merge('fRemoved');
const prevField = r => PREVSNAP[r.orgs[0]].get(r.obj + '.' + r.field);
const remHTML = removed.length
  ? byObject(removed, r => li(r, fieldHead(r, friendlyType(r.type, prevField(r))) + descOf(r)))
  : '<p class="cnone">No fields were deleted.</p>';

function changeText(c) {
  if (c.attr === 'picklist') {
    if (!c.added.length && !c.removed.length) return '<span class="cchg">Picklist values were re-ordered.</span>';
    return '<span class="cchg">' +
      (c.added.length ? '<span class="ck">Values added</span>' + c.added.map(v => '<span class="pv add">' + esc(v) + '</span>').join('') : '') +
      (c.removed.length ? '<span class="ck">Values removed</span>' + c.removed.map(v => '<span class="pv rem">' + esc(v) + '</span>').join('') : '') +
      '</span>';
  }
  if (c.attr === 'required') return '<span class="cchg">' + (c.to ? 'Now <b>required</b>' : 'No longer required') + '</span>';
  if (c.attr === 'type') return '<span class="cchg">Type changed from <span class="pv rem">' + esc(friendlyType(c.from)) +
    '</span> to <span class="pv add">' + esc(friendlyType(c.to)) + '</span></span>';
  return '<span class="cchg">' + esc(c.attr) + ': ' + esc(String(c.from)) + ' &rarr; ' + esc(String(c.to)) + '</span>';
}
const changed = merge('fChanged');
const chgHTML = changed.length
  ? byObject(changed, r => {
      const per = r.orgs.map(id => JSON.stringify(r.byOrg[id].changes));
      const same = per.every(x => x === per[0]);
      const detail = same
        ? '<div class="corg">' + r.byOrg[r.orgs[0]].changes.map(changeText).join('') + '</div>'
        : r.orgs.map(id => '<div class="corg">' + orgBadge([id]) + r.byOrg[id].changes.map(changeText).join('') + '</div>').join('');
      return li(r, fieldHead(r, friendlyType(snapField(r) ? snapField(r).type : '', snapField(r))) + viewBtn(r) + descOf(r) + detail);
    })
  : '<p class="cnone">No existing fields were changed.</p>';

// Real object additions/removals (not coverage changes) — rare, so only shown when present.
const objRows = [];
for (const id of ['sbu', 'xbu']) {
  for (const a of CH[id].objAdded) objRows.push({ id, a, kind: 'New' });
  for (const a of CH[id].objRemoved) objRows.push({ id, a, kind: 'Deleted' });
}
const objHTML = objRows.length
  ? '<section class="csec" id="chObjects" data-kind="objects"><h2>Objects added or deleted <span class="cnt">' + nf(objRows.length) + '</span></h2><ul class="clist">' +
    objRows.map(o => '<li' + rowAttrs([o.id], o.a) + '>' + orgBadge([o.id]) + '<span class="cfl">' + esc(objLabel(o.a)) + '</span><code class="capi">' + esc(o.a) +
      '</code><span class="cty">' + o.kind + ' object</span></li>').join('') + '</ul>' + NOMATCH + '</section>'
  : '';

const visHTML = visibleF.length
  ? '<details class="cmore" data-kind="new"><summary><span class="cnt2">' + nf(visibleF.length) + '</span> ' + (visibleF.length === 1 ? 'field' : 'fields') +
    ' newly visible in the dictionary &mdash; not new in Salesforce</summary>' +
    '<p>These fields already existed in Salesforce before ' + esc(niceDate(PREV)) + ', but the previous scan could not see them ' +
    '(usually because of field-level security on the account that runs the scan). Nothing about them changed in Salesforce, ' +
    'so they are not counted as new above.</p>' +
    byObject(visibleF, r => li(r, fieldHead(r, friendlyType(r.type, snapField(r))) + '<span class="cwhen">' + esc(createdOn(r)) + '</span>' + descOf(r))) +
    NOMATCH + '</details>'
  : '';

// Change-page filter choices: every object that has at least one change row.
const chObjs = [...new Set([...newF, ...changed, ...removed, ...visibleF].map(r => r.obj).concat(objRows.map(o => o.a)))]
  .sort((a, b) => objLabel(a).localeCompare(objLabel(b)));
const chObjOptions = chObjs.map(a => '<option value="' + esc(a) + '">' + esc(objLabel(a) !== a ? objLabel(a) + ' (' + a + ')' : a) + '</option>').join('');

const cov = id => CH[id].churnAdded.length + CH[id].churnRemoved.length;
const covHTML = (cov('sbu') || cov('xbu'))
  ? '<details class="cmore" data-kind="coverage"><summary>The dictionary&rsquo;s coverage changed &mdash; not a Salesforce change</summary>' +
    '<p>The set of objects the dictionary scans was updated. It now includes ' + plural(CH.sbu.churnAdded.length, 'more object') +
    ' in SBU and ' + nf(CH.xbu.churnAdded.length) + ' in XBU, and no longer lists ' + nf(CH.sbu.churnRemoved.length) + ' SBU and ' +
    nf(CH.xbu.churnRemoved.length) + ' XBU platform-event objects. These objects were already in Salesforce, so they are not counted as changes.</p>' +
    '</details>'
  : '';

function orgSummary(id, name, sub) {
  const r = CH[id];
  const nNew = r.fAdded.filter(f => f.newInWindow !== false).length;
  const stat = (n, cls, word) => '<div><b class="' + cls + '">' + nf(n) + '</b><span>' + word + '</span></div>';
  return '<div class="csum" data-org="' + id + '"><div class="csum-h">' + orgBadge([id]) + '<b>' + esc(name) + '</b><span>' + esc(sub) + '</span></div>' +
    '<div class="csum-n">' + stat(nNew, 'add', nNew === 1 ? 'new field' : 'new fields') +
    stat(r.fRemoved.length, 'rem', 'deleted') + stat(r.fChanged.length, 'chg', 'changed') + '</div>' +
    '<div class="csum-t">' + nf(r.curObjects) + ' objects &middot; ' + nf(r.curFields) + ' fields in the dictionary</div></div>';
}

// The Show filter: every field type Setup offers, under its Setup name. Keys are what
// typeKey() in the explorer returns; a field matches exactly one.
const FIELD_TYPE_GROUPS = [
  ['Calculated', [['autonumber', 'Auto Number'], ['formula', 'Formula'], ['rollup', 'Roll-Up Summary']]],
  ['Relationships', [['lookup', 'Lookup Relationship'], ['masterdetail', 'Master-Detail Relationship'],
    ['externallookup', 'External Lookup Relationship'], ['indirectlookup', 'Indirect Lookup Relationship']]],
  ['Data types', [['boolean', 'Checkbox'], ['currency', 'Currency'], ['date', 'Date'], ['datetime', 'Date/Time'],
    ['email', 'Email'], ['location', 'Geolocation'], ['number', 'Number'], ['percent', 'Percent'], ['phone', 'Phone'],
    ['picklist', 'Picklist'], ['multipicklist', 'Picklist (Multi-Select)'], ['string', 'Text'], ['textarea', 'Text Area'],
    ['longtextarea', 'Text Area (Long)'], ['richtext', 'Text Area (Rich)'], ['encryptedstring', 'Text (Encrypted)'],
    ['time', 'Time'], ['url', 'URL']]],
  ['Standard fields only', [['address', 'Address'], ['id', 'Record ID'], ['base64', 'File / Binary']]],
];

const HTML = `<title>Salesforce Data Dictionary — SBU &amp; XBU Production</title>
<style>
:root{
  --bg:#eaeef3; --surface:#ffffff; --surface2:#f4f7fa;
  --ink:#16222e; --ink2:#33404d; --muted:#5f6f7e; --faint:#8494a2;
  --line:#dde4ec; --line2:#e9eef4; --accent:#1f6aa8; --accent-ink:#0e4c7d; --accent-soft:#e4eef6;
  --c-formula:#6d55d6; --c-ref:#2277bd; --c-pick:#4a5ad0; --c-num:#1f8f80; --c-date:#2b7f9e;
  --c-text:#6a7684; --c-bool:#8a6a2f; --c-other:#7a869a;
  --req:#b5671a; --uniq:#1f8560; --extid:#7a52bf;
  --org-sbu:#157f6d; --org-xbu:#5a54c9; --diff:#b5671a; --org-both:#2f6496; --reqhl:#c2185b; --req-bg:#fdf1f6; --managed:#7a5c00;
  --shadow:0 1px 2px rgba(20,35,52,.06),0 6px 20px rgba(20,35,52,.06);
  --pop:0 8px 28px rgba(20,35,52,.16);
  --radius:10px; --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0c131b; --surface:#141d27; --surface2:#0f1822;
  --ink:#e8eef5; --ink2:#c3ced9; --muted:#8b9bab; --faint:#647585;
  --line:#243240; --line2:#1c2836; --accent:#4ea6e6; --accent-ink:#8fcbf3; --accent-soft:#16304a;
  --c-formula:#a795ff; --c-ref:#5aaef0; --c-pick:#8a97f0; --c-num:#4cc4b2; --c-date:#63b8d6;
  --c-text:#9aa6b4; --c-bool:#c7a45f; --c-other:#9aa6ba;
  --req:#e0954a; --uniq:#4cc49a; --extid:#b79bf0;
  --org-sbu:#45b8a6; --org-xbu:#9a95f0; --diff:#e0954a; --org-both:#7fb2e0; --reqhl:#f06d9b; --req-bg:#2b1622; --managed:#d9b44a;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 26px rgba(0,0,0,.35);
  --pop:0 10px 34px rgba(0,0,0,.55);
}}
:root[data-theme="light"]{
  --bg:#eaeef3; --surface:#ffffff; --surface2:#f4f7fa;
  --ink:#16222e; --ink2:#33404d; --muted:#5f6f7e; --faint:#8494a2;
  --line:#dde4ec; --line2:#e9eef4; --accent:#1f6aa8; --accent-ink:#0e4c7d; --accent-soft:#e4eef6;
  --c-formula:#6d55d6; --c-ref:#2277bd; --c-pick:#4a5ad0; --c-num:#1f8f80; --c-date:#2b7f9e;
  --c-text:#6a7684; --c-bool:#8a6a2f; --c-other:#7a869a; --req:#b5671a; --uniq:#1f8560; --extid:#7a52bf;
  --org-sbu:#157f6d; --org-xbu:#5a54c9; --diff:#b5671a; --org-both:#2f6496; --reqhl:#c2185b; --req-bg:#fdf1f6; --managed:#7a5c00;
  --shadow:0 1px 2px rgba(20,35,52,.06),0 6px 20px rgba(20,35,52,.06);
  --pop:0 8px 28px rgba(20,35,52,.16);
}
:root[data-theme="dark"]{
  --bg:#0c131b; --surface:#141d27; --surface2:#0f1822;
  --ink:#e8eef5; --ink2:#c3ced9; --muted:#8b9bab; --faint:#647585;
  --line:#243240; --line2:#1c2836; --accent:#4ea6e6; --accent-ink:#8fcbf3; --accent-soft:#16304a;
  --c-formula:#a795ff; --c-ref:#5aaef0; --c-pick:#8a97f0; --c-num:#4cc4b2; --c-date:#63b8d6;
  --c-text:#9aa6b4; --c-bool:#c7a45f; --c-other:#9aa6ba; --req:#e0954a; --uniq:#4cc49a; --extid:#b79bf0;
  --org-sbu:#45b8a6; --org-xbu:#9a95f0; --diff:#e0954a; --org-both:#7fb2e0; --reqhl:#f06d9b; --req-bg:#2b1622; --managed:#d9b44a;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 26px rgba(0,0,0,.35);
  --pop:0 10px 34px rgba(0,0,0,.55);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.app{display:grid;grid-template-columns:320px 1fr;grid-template-rows:auto 1fr;height:100vh;overflow:hidden}
header{grid-column:1/3;display:flex;align-items:center;gap:20px;padding:12px 22px;background:var(--surface);border-bottom:1px solid var(--line);flex-wrap:wrap}
.brand{display:flex;flex-direction:column;gap:1px;min-width:200px}
.brand h1{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em}
.brand .sub{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.stats{display:flex;gap:18px;margin-left:auto;flex-wrap:wrap}
.stat{display:flex;flex-direction:column;line-height:1.15}
.stat b{font-size:16px;font-weight:660;font-variant-numeric:tabular-nums}
.stat span{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint)}
.theme-btn{border:1px solid var(--line);background:var(--surface2);color:var(--ink2);border-radius:8px;padding:7px 10px;font-size:12px;cursor:pointer;font-family:inherit}
.theme-btn:hover{border-color:var(--accent)}

aside{border-right:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;min-height:0}
.search{padding:12px;border-bottom:1px solid var(--line2);display:flex;flex-direction:column;gap:11px}
.search input[type=search]{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--surface2);color:var(--ink);font-family:inherit;font-size:13px}
.search input[type=search]:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}

.fld{display:flex;flex-direction:column;gap:4px}
.fld>label,.fld>span.lbl{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:650}
.ctl{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface2);color:var(--ink);
  font-family:inherit;font-size:12.5px;cursor:pointer;text-align:left;line-height:1.35}
.ctl:hover{border-color:var(--accent)}
select.ctl{appearance:none;-webkit-appearance:none;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 15px) calc(50% + 1px),calc(100% - 10px) calc(50% + 1px);
  background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:28px;color:var(--ink)}
.multi{position:relative}
.multi>.ctl{display:flex;align-items:center;justify-content:space-between;gap:8px}
.multi>.ctl .caret{color:var(--faint);flex-shrink:0}
.multi[data-open="true"]>.ctl{border-color:var(--accent);outline:2px solid var(--accent);outline-offset:-1px}
.pop{position:absolute;z-index:40;top:calc(100% + 5px);left:0;right:0;background:var(--surface);border:1px solid var(--line);
  border-radius:9px;box-shadow:var(--pop);padding:8px;display:flex;flex-direction:column;gap:2px}
.pop[hidden]{display:none}
#popType{max-height:min(68vh,560px);overflow-y:auto}
.optl{flex:1}
.optn{font-size:10.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.opt.zero{opacity:.5}
.opt{display:flex;align-items:center;gap:8px;padding:6px 7px;border-radius:6px;cursor:pointer;font-size:12.5px;color:var(--ink2)}
.opt:hover{background:var(--surface2)}
.opt input{accent-color:var(--accent);margin:0;width:14px;height:14px}
.opthead{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:700;padding:5px 7px 2px}
.popsep{border-top:1px solid var(--line2);margin:4px 0 2px}
.popfoot{display:flex;align-items:center;gap:6px;border-top:1px solid var(--line2);margin-top:5px;padding-top:7px}
.popfoot .lbl2{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:650;margin-right:auto}
.seg{display:flex;gap:2px;padding:2px;background:var(--surface2);border:1px solid var(--line);border-radius:7px}
.seg button{border:1px solid transparent;background:none;color:var(--muted);font-family:inherit;font-size:11px;font-weight:600;
  padding:2px 9px;border-radius:5px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}
.fld.sub{margin:-3px 0 0 10px;padding:3px 0 0 11px;border-left:2px solid var(--line)}
.fld.sub>.lbl::before{content:'↳ ';color:var(--faint)}
.badgefilter{display:flex;flex-wrap:wrap;gap:6px}
.bopt{display:flex;align-items:center;gap:5px;cursor:pointer;padding:3px 7px 3px 5px;border:1px solid var(--line);border-radius:7px;background:var(--surface2)}
.bopt input{accent-color:var(--accent);margin:0;width:13px;height:13px}
.bopt.off{opacity:.45;cursor:not-allowed}
input.ctl{cursor:text}
.clearall{border:0;background:none;color:var(--accent);font-family:inherit;font-size:11.5px;cursor:pointer;padding:0;
  text-decoration:underline;text-underline-offset:2px;align-self:flex-start}

.objlist{overflow-y:auto;flex:1;padding:6px}
.grouphead{font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:700;padding:9px 9px 4px}
.grouphead+.obj{margin-top:0}
.objlist .grouphead:not(:first-child){border-top:1px solid var(--line2);margin-top:6px;padding-top:9px}
.obj{width:100%;text-align:left;border:0;background:none;color:inherit;font-family:inherit;display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:8px;cursor:pointer}
.obj:hover{background:var(--surface2)}
.obj[aria-current="true"]{background:var(--accent-soft)}
.obj .olabel{font-size:12.5px;font-weight:560;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.obj .oapi{font-family:var(--mono);font-size:10.5px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.obj .otext{min-width:0;flex:1;display:flex;flex-direction:column;line-height:1.25}
.obj .osub{display:flex;align-items:center;gap:5px;min-width:0;margin-top:2px}
.obj .osub .tag{font-size:8.5px;padding:0 4px}
.count{font-size:10.5px;color:var(--faint);font-variant-numeric:tabular-nums;background:var(--surface2);border:1px solid var(--line2);border-radius:6px;padding:1px 6px;flex-shrink:0}
.count.match{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}
.tag{font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;padding:1px 5px;border-radius:5px;flex-shrink:0;font-weight:650}
.tag.custom{color:var(--c-num);border:1px solid var(--c-num);background:transparent}
.tag.std{color:var(--faint);border:1px solid var(--line)}
.orgtag{font-size:9.5px;letter-spacing:.05em;font-weight:800;padding:2px 6px;border-radius:5px;flex-shrink:0;border:1px solid;white-space:nowrap;text-transform:uppercase;color:var(--surface)}
.orgtag.sbu{background:var(--org-sbu);border-color:var(--org-sbu)}
.orgtag.xbu{background:var(--org-xbu);border-color:var(--org-xbu)}
.orgtag.both{background:var(--org-both);border-color:var(--org-both)}
.diffchip{font-size:9px;letter-spacing:.04em;text-transform:uppercase;font-weight:800;color:var(--surface);background:var(--diff);border:1px solid var(--diff);
  border-radius:5px;padding:2px 6px;flex-shrink:0;font-variant-numeric:tabular-nums}

main{overflow-y:auto;min-height:0;padding:20px 24px 60px}
.mhead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.mhead h2{margin:0;font-size:28px;font-weight:700;letter-spacing:-.015em}
.mhead .mapi{font-family:var(--mono);font-size:15px;color:var(--muted)}
.mhead .orgtag,.mhead .tag{font-size:12.5px;padding:4px 10px;border-radius:6px;align-self:center}
.mhead .mlabel{font-size:14px;color:var(--muted)}
.mmeta{font-size:14px;color:var(--muted);margin-bottom:18px;font-variant-numeric:tabular-nums}
.field{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;margin-bottom:9px;box-shadow:var(--shadow)}
.field{display:flex;gap:14px;align-items:flex-start}
.frail{display:flex;flex-direction:column;gap:6px;width:74px;flex-shrink:0}
.mgdchip{font-size:9px;letter-spacing:.04em;text-transform:uppercase;font-weight:800;color:var(--surface);background:var(--managed);
  border:1px solid var(--managed);border-radius:5px;padding:2px 6px;flex-shrink:0;white-space:nowrap}
.srcchip{font-size:9px;letter-spacing:.03em;text-transform:uppercase;font-weight:800;border:1px solid;border-radius:5px;padding:2px 6px;white-space:nowrap;background:var(--surface)}
.srcchip.custom{color:var(--c-num);border-color:var(--c-num)}
.srcchip.std{color:var(--muted);border-color:var(--line)}
.frail .orgtag,.frail .diffchip,.frail .attr,.frail .mgdchip,.frail .srcchip{display:block;text-align:center;font-size:11px;padding:5px 0;border-radius:6px;box-shadow:0 1px 2px rgba(0,0,0,.15)}
.frail .srcchip{white-space:normal;line-height:1.25;padding:4px 2px}
.field.isreq{background:var(--req-bg);border-color:var(--reqhl);box-shadow:inset 4px 0 0 var(--reqhl),var(--shadow)}
.field.differs{border-left:3px solid var(--diff)}
.frow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.flabel{color:var(--ink);font-size:14px;font-weight:700}
.fbadges{display:flex;gap:5px;flex-wrap:wrap;margin-left:auto}
.fobj{color:var(--muted);font-size:12.5px}
.fapi{font-family:var(--mono);font-size:12px;color:var(--ink2);overflow-wrap:anywhere}
.fapi .fnameobj{color:var(--faint)}
.type{font-size:11.5px;padding:1px 8px;border-radius:6px;border:1px solid;font-weight:600;white-space:nowrap}
.attrs{display:flex;gap:5px;margin-left:auto;flex-wrap:wrap}
.attr{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:700;padding:2px 6px;border-radius:5px}
.attr.req{color:var(--surface);background:var(--reqhl);border:1px solid var(--reqhl)}
.attr.uniq{color:var(--uniq);border:1px solid var(--uniq)}
.attr.ext{color:var(--extid);border:1px solid var(--extid)}
.fdetail{display:flex;flex-direction:column;gap:7px;flex:1;min-width:0}
.kv{display:flex;gap:8px;font-size:12.5px;align-items:baseline}
.kv .k{background:var(--accent-soft);color:var(--accent-ink);font-weight:700;font-size:11.5px;padding:1px 8px;border-radius:5px;min-width:104px;flex-shrink:0;white-space:nowrap}
.kv .v.frow{flex:1;min-width:0}
.kv .v{color:var(--ink2)}
.diffs{display:flex;flex-direction:column;gap:5px;flex:1}
.diffrow{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.dk{font-size:11px;font-weight:650;color:var(--diff);min-width:88px}
.dvals{display:flex;gap:8px;flex-wrap:wrap;flex:1}
.dv{font-size:12px;color:var(--ink2);background:var(--surface2);border:1px solid var(--line2);border-radius:6px;padding:1px 7px}
.dv i{font-style:normal;font-weight:750;font-size:9px;letter-spacing:.05em;margin-right:5px}
.dv.sbu i{color:var(--org-sbu)} .dv.xbu i{color:var(--org-xbu)}
.reflist{display:flex;gap:6px;flex-wrap:wrap}
.reflist span{background:var(--surface2);border:1px solid var(--line2);border-radius:6px;padding:1px 6px;color:var(--c-ref);font-family:var(--mono);font-size:12px}
.pills{display:flex;gap:5px;flex-wrap:wrap}
.pill{background:var(--surface2);border:1px solid var(--line2);border-radius:6px;padding:1px 7px;font-size:11.5px;color:var(--ink2)}
.formula{font-family:var(--mono);font-size:12px;background:var(--surface2);border:1px solid var(--line2);border-left:3px solid var(--c-formula);border-radius:6px;padding:9px 11px;white-space:pre-wrap;overflow-x:auto;color:var(--ink2)}
.cmp{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.cmp .cl{font-size:9.5px;font-weight:750;letter-spacing:.05em;margin-bottom:2px}
.cmp .cl.sbu{color:var(--org-sbu)} .cmp .cl.xbu{color:var(--org-xbu)}
.toggle{background:none;border:0;color:var(--accent);cursor:pointer;font-family:inherit;font-size:12px;padding:0;text-decoration:underline;text-underline-offset:2px}
.desc{color:var(--ink2);font-size:12.5px}
.help{color:var(--muted);font-size:12.5px;font-style:italic}
.empty{color:var(--muted);text-align:center;padding:60px 20px}
.hidden{display:none!important}
mark{background:var(--accent-soft);color:var(--accent-ink);border-radius:3px;padding:0 1px}
.note{font-size:12px;color:var(--faint);margin:2px 0 14px}
.legend{border-top:1px solid var(--line2);padding-top:9px;font-size:11.5px;color:var(--ink2)}
.legend summary{cursor:pointer;color:var(--accent);font-size:11.5px}
.legend dl{display:grid;grid-template-columns:auto 1fr;gap:7px 9px;margin:9px 0 2px;align-items:center}
.legend dt{display:flex;gap:4px;flex-wrap:wrap}
.legend dd{margin:0;color:var(--muted);line-height:1.35}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:6px;border:3px solid var(--surface)}
@media (max-width:820px){.app{grid-template-columns:1fr;grid-template-rows:auto auto 1fr}aside{max-height:46vh}main{grid-column:1}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}

/* ---- changes landing page ---- */
#changesView[hidden]{display:none}
#changesView{height:100vh;overflow-y:auto;background:var(--bg)}
.cwrap{max-width:1040px;margin:0 auto;padding:0 24px 72px}
.chead{padding:34px 0 18px;border-bottom:1px solid var(--line);display:flex;align-items:flex-end;gap:18px;flex-wrap:wrap}
.chead h1{margin:0;font-size:30px;font-weight:700;letter-spacing:-.02em}
.chead .csince{font-size:15px;color:var(--muted);margin-top:4px}
.chead .cgo{margin-left:auto;display:flex;gap:8px}
.btn{border:1px solid var(--line);background:var(--surface);color:var(--ink2);border-radius:8px;
  padding:9px 15px;font-size:13px;font-family:inherit;cursor:pointer}
.btn:hover{border-color:var(--accent);color:var(--accent-ink)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--surface);font-weight:650}
.btn.primary:hover{color:var(--surface);filter:brightness(1.08)}
.cintro{color:var(--ink2);font-size:14px;max-width:80ch;margin:16px 0 0}
.csums{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:20px}
.csum{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow)}
.csum-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:12px}
.csum-h b{font-size:15px}
.csum-h span{font-size:12px;color:var(--faint)}
.csum-h .orgtag{font-size:11px;padding:3px 9px;color:var(--surface)}
.csum-n{display:flex;gap:10px;flex-wrap:wrap}
.csum-n div{flex:1;min-width:84px;background:var(--surface2);border:1px solid var(--line2);border-radius:8px;padding:9px 12px}
.csum-n b{display:block;font-size:26px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.csum-n span{font-size:12px;color:var(--muted)}
.csum-n .add{color:var(--uniq)} .csum-n .rem{color:var(--reqhl)} .csum-n .chg{color:var(--diff)}
.csum-t{font-size:12px;color:var(--faint);margin-top:10px}
.csec{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin-top:18px;box-shadow:var(--shadow)}
.csec h2{margin:0 0 12px;font-size:18px;font-weight:680;display:flex;align-items:center;gap:8px}
.cnt{font-size:12px;font-weight:700;color:var(--accent-ink);background:var(--accent-soft);border-radius:999px;padding:1px 9px}
.cnone{color:var(--muted);font-size:13.5px;margin:0}
.cobj+.cobj{margin-top:14px}
.cobj-h{display:flex;align-items:baseline;gap:8px;margin-bottom:2px;padding-bottom:5px;border-bottom:1px solid var(--line2)}
.cobj-h b{font-size:14.5px}
.cobj-h code{font-family:var(--mono);font-size:11.5px;color:var(--faint)}
.cn{font-size:11.5px;color:var(--faint);margin-left:auto}
ul.clist{list-style:none;margin:0;padding:0}
ul.clist li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 0;border-bottom:1px dotted var(--line2)}
ul.clist li:last-child{border-bottom:0}
ul.clist .orgtag{color:var(--surface)}
.cfl{font-weight:650;font-size:14px;color:var(--ink)}
.capi{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.cty{font-size:11.5px;color:var(--ink2);border:1px solid var(--line);border-radius:6px;padding:0 7px}
.cwhen{font-size:12px;color:var(--muted)}
.cview{margin-left:auto;border:1px solid var(--accent);background:var(--accent-soft);color:var(--accent-ink);border-radius:7px;
  padding:3px 11px;font-size:12px;font-family:inherit;cursor:pointer;font-weight:600}
.cview:hover{background:var(--accent);color:var(--surface)}
.corg{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding-left:2px}
.cchg{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;color:var(--ink2)}
.ck{font-size:11.5px;font-weight:700;color:var(--muted);margin-left:4px}
.pv{font-size:12px;padding:1px 7px;border-radius:5px}
.pv.add{color:var(--uniq);border:1px solid var(--uniq)}
.pv.rem{color:var(--reqhl);border:1px solid var(--reqhl);text-decoration:line-through}
.cmore{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:12px 18px;margin-top:18px}
.cmore summary{cursor:pointer;font-weight:650;font-size:14px;color:var(--ink2)}
.cmore p{font-size:13px;color:var(--ink2);max-width:82ch;margin:10px 0}
.cdesc{flex-basis:100%;font-size:12.5px;color:var(--ink2);background:var(--surface2);border-left:3px solid var(--line);border-radius:4px;padding:4px 10px}
.cfilt{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;align-items:end;margin-top:18px;
  background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 18px;box-shadow:var(--shadow)}
.cfilt .clearall{align-self:center}
ul.clist li[hidden],.cobj[hidden],.csec[hidden],.cmore[hidden],.csum[hidden]{display:none}
</style>

<div id="changesView">
  <div class="cwrap">
    <div class="chead">
      <div>
        <h1>What changed in Salesforce</h1>
        <div class="csince">${esc(niceDate(PREV))} &rarr; ${esc(niceDate(GEN))}</div>
      </div>
      <div class="cgo">
        <button class="btn" id="themeBtn2" type="button">Theme</button>
        <button class="btn primary" id="toDict" type="button">Open the dictionary &rarr;</button>
      </div>
    </div>

    <p class="cintro">Fields that were created, changed or deleted in the SBU and XBU production orgs between the last
    two monthly scans. Use <b>View in dictionary</b> on any field to see its full details.</p>

    <div class="csums">
      ${orgSummary('sbu', 'SBU Production', 'POS Nation · Quilt Software')}
      ${orgSummary('xbu', 'XBU Production', 'Rain POS')}
    </div>

    <div class="cfilt" id="chFilters" role="group" aria-label="Filter changes">
      <div class="fld">
        <label for="chOrg">Org</label>
        <select class="ctl" id="chOrg">
          <option value="all" selected>Both orgs</option>
          <option value="sbu">SBU only — POS Nation</option>
          <option value="xbu">XBU only — Rain POS</option>
        </select>
      </div>
      <div class="fld">
        <label for="chKind">Type of change</label>
        <select class="ctl" id="chKind">
          <option value="all" selected>All changes</option>
          <option value="new">New fields</option>
          <option value="changed">Changed fields</option>
          <option value="removed">Deleted fields</option>
          ${objRows.length ? '<option value="objects">Objects added or deleted</option>' : ''}
        </select>
      </div>
      <div class="fld">
        <label for="chObj">Object</label>
        <select class="ctl" id="chObj">
          <option value="all" selected>All objects</option>
          ${chObjOptions}
        </select>
      </div>
      <button class="clearall" type="button" id="chClear" hidden>Clear filters</button>
    </div>

    <section class="csec" id="chNew" data-kind="new"><h2>New fields <span class="cnt">${nf(newF.length)}</span></h2>${newHTML}${NOMATCH}</section>
    <section class="csec" id="chChanged" data-kind="changed"><h2>Changed fields <span class="cnt">${nf(changed.length)}</span></h2>${chgHTML}${NOMATCH}</section>
    <section class="csec" id="chRemoved" data-kind="removed"><h2>Deleted fields <span class="cnt">${nf(removed.length)}</span></h2>${remHTML}${NOMATCH}</section>
    ${objHTML}
    ${visHTML}
    ${covHTML}
  </div>
</div>

<div class="app" id="appView" hidden>
  <header>
    <div class="brand">
      <h1>Salesforce Data Dictionary</h1>
      <span class="sub" id="orgsub"></span>
    </div>
    <div class="stats" id="stats"></div>
    <button class="theme-btn" id="toChanges" type="button">&larr; Changes</button>
    <button class="theme-btn" id="themeBtn" type="button">Theme</button>
  </header>

  <aside>
    <div class="search">
      <input id="q" type="search" placeholder="Search by label, API name or description…" autocomplete="off" spellcheck="false" aria-label="Search objects and fields">

      <div class="fld">
        <label for="fBu">Org</label>
        <select class="ctl" id="fBu">
          <option value="both" selected>Both orgs (SBU + XBU)</option>
          <option value="sbu">SBU only — POS Nation</option>
          <option value="xbu">XBU only — Rain POS</option>
        </select>
      </div>

      <div class="fld">
        <label for="fObj">Object</label>
        <select class="ctl" id="fObj">
          <option value="both" selected>All objects</option>
        </select>
      </div>

      <div class="fld">
        <label for="fOrigin">Fields</label>
        <select class="ctl" id="fOrigin">
          <option value="all" selected>All fields</option>
          <option value="custom">Custom fields only (built in-house)</option>
          <option value="managed">Managed package fields only</option>
          <option value="standard">Standard fields only</option>
        </select>
      </div>

      <div class="fld sub">
        <span class="lbl" id="lblType">Show</span>
        <div class="multi" id="mType" data-open="false">
          <button class="ctl" type="button" id="btnType" aria-haspopup="true" aria-expanded="false" aria-labelledby="lblType btnType">
            <span id="typeSummary">All fields</span><span class="caret" aria-hidden="true">▾</span>
          </button>
          <div class="pop" id="popType" hidden role="group" aria-label="Type of field">
            <label class="opt"><input type="checkbox" id="cbAll" value="__all" checked> All fields</label>
            ${FIELD_TYPE_GROUPS.map(([head, types]) => '<div class="popsep"></div><div class="opthead">' + esc(head) + '</div>' +
              types.map(([k, l]) => '<label class="opt"><input type="checkbox" value="' + k + '"> <span class="optl">' + esc(l) +
                '</span><span class="optn" data-n="' + k + '"></span></label>').join('')).join('\n            ')}
          </div>
        </div>
      </div>

      <div class="fld">
        <label for="fLabel">Field label contains</label>
        <input class="ctl" id="fLabel" type="search" placeholder="e.g. status" autocomplete="off" spellcheck="false">
      </div>

      <div class="fld">
        <span class="lbl" id="lblBadges">Badges</span>
        <div class="badgefilter" id="fBadges" role="group" aria-labelledby="lblBadges">
          <label class="bopt"><input type="checkbox" value="both"><span class="orgtag both">Both</span></label>
          <label class="bopt"><input type="checkbox" value="sbuonly"><span class="orgtag sbu">SBU only</span></label>
          <label class="bopt"><input type="checkbox" value="xbuonly"><span class="orgtag xbu">XBU only</span></label>
          <label class="bopt"><input type="checkbox" value="differs"><span class="diffchip">Differs</span></label>
          <label class="bopt"><input type="checkbox" value="required"><span class="attr req">Required</span></label>
          <label class="bopt"><input type="checkbox" value="managed"><span class="mgdchip">Managed</span></label>
        </div>
      </div>

      <button class="clearall" type="button" id="clearAll" hidden>Clear filters</button>

      <details class="legend">
        <summary>What do the labels mean?</summary>
        <dl>
          <dt><span class="orgtag both">Both</span></dt><dd>Exists in both SBU and XBU</dd>
          <dt><span class="orgtag sbu">SBU</span><span class="orgtag xbu">XBU</span></dt><dd>Exists in that org only</dd>
          <dt><span class="tag custom">Custom</span><span class="tag std">Standard</span></dt><dd>Object list: a custom object, or one that comes with Salesforce</dd>
          <dt><span class="srcchip custom">Custom Field</span><span class="srcchip std">Standard Field</span></dt><dd>Field card: a custom field built in-house, or one that comes with Salesforce</dd>
          <dt><span class="diffchip">3 differ</span></dt><dd>Fields set up differently in SBU and XBU</dd>
          <dt><span class="count">42</span></dt><dd>Number of fields (or matches while searching)</dd>
          <dt><span class="attr req">Required</span></dt><dd>Must have a value before the record can be saved (card is highlighted pink)</dd>
          <dt><span class="mgdchip">Managed</span></dt><dd>Installed by a managed package (an AppExchange app), named in the Package row. Cannot be deleted</dd>
          <dt><span class="attr uniq">Unique</span></dt><dd>No two records can share the same value</dd>
          <dt><span class="attr ext">External Id</span></dt><dd>Used to match records from imports and integrations</dd>
        </dl>
      </details>
    </div>
    <div class="objlist" id="objlist"></div>
  </aside>

  <main id="main"></main>
</div>

<script id="payload" type="text/plain">${packedB64}</script>
<script id="explorer" type="text/plain">
(function(){
const P=window.P, POOL_REF=P.pools.ref, POOL_PICK=P.pools.pick;
const ORDER=P.orgs.map(o=>o.id);

// Objects kept at the top of the list regardless of search or filters.
const PINNED=['Account','Contact','Lead','Opportunity','Case','Merchant_ID__c','Residual_Payment__c','POS_Software__c','Quote'];
const PIN_RANK={}; PINNED.forEach((a,i)=>PIN_RANK[a]=i);

function decodeOrg(o){
  return o.objs.map(t=>({
    api:t[0], label:t[1], custom:!!t[2],
    fields:t[3].map(f=>({
      name:f[0], label:f[1], type:f[2], len:f[3],
      req:!!(f[4]&1), uniq:!!(f[4]&2), extId:!!(f[4]&4),
      formula:f[5]||'', desc:f[6]||'', help:f[7]||'',
      ref:POOL_REF[f[8]||0], pick:POOL_PICK[f[9]||0], gvs:f[10]||'', kind:f[11]||''
    }))
  }));
}
const ORGS={};
for(const o of P.orgs) ORGS[o.id]={meta:o, data:decodeOrg(o), apis:new Set(o.objs.map(x=>x[0]))};

// ---- merged view: one object per API name, fields unioned across orgs ----
// Description and help text are deliberately NOT compared: XBU documents far fewer
// fields, and that shouldn't make a structurally identical field read as different.
const CMP=['label','type','len','req','uniq','extId','formula','gvs'];
const CMP_LABEL={label:'Label',type:'Type',len:'Length',req:'Required',uniq:'Unique',
  extId:'External Id',formula:'Formula',gvs:'Value set',ref:'Lookup to',pick:'Picklist values'};
function diffOf(a,b){
  const d=[];
  for(const k of CMP) if(String(a[k])!==String(b[k])) d.push(k);
  if((a.ref||[]).join('|')!==(b.ref||[]).join('|')) d.push('ref');
  if((a.pick||[]).join('|')!==(b.pick||[]).join('|')) d.push('pick');
  return d;
}
const COMBINED=(function(){
  const byApi=new Map();
  for(const id of ORDER){
    for(const o of ORGS[id].data){
      let e=byApi.get(o.api);
      if(!e){e={api:o.api,label:o.label,custom:o.custom,orgs:[],_maps:{}};byApi.set(o.api,e);}
      e.orgs.push(id);
      e._maps[id]=new Map(o.fields.map(f=>[f.name,f]));
      if(!e.label) e.label=o.label;
    }
  }
  const out=[];
  for(const e of byApi.values()){
    const names=new Set();
    for(const id of e.orgs) for(const n of e._maps[id].keys()) names.add(n);
    const fields=[];
    for(const n of [...names].sort()){
      const vs={}; const present=[];
      for(const id of e.orgs){const f=e._maps[id].get(n); if(f){vs[id]=f;present.push(id);}}
      const primary=vs[present[0]];
      const diffs=present.length>1?diffOf(vs[present[0]],vs[present[1]]):[];
      // prefer whichever org actually documents the field
      let desc='',help='';
      for(const id of present){ if(!desc&&vs[id].desc)desc=vs[id].desc; if(!help&&vs[id].help)help=vs[id].help; }
      fields.push(Object.assign({},primary,{desc:desc,help:help,_orgs:present,_diffs:diffs,_v:vs}));
    }
    delete e._maps;
    out.push({api:e.api,label:e.label,custom:e.custom,orgs:e.orgs,fields:fields,
      nDiff:fields.filter(f=>f._diffs.length).length});
  }
  return out;
})();

// ---- state ----
let bu='both', objScope='both', typeSel=new Set();
let pinnedObj=null, query='';
let badgeSel=new Set(), labelQ='', originSel='all';
const CAP=500;

const main=document.getElementById('main'), list=document.getElementById('objlist'), q=document.getElementById('q');
const statsEl=document.getElementById('stats'), subEl=document.getElementById('orgsub');
const selBu=document.getElementById('fBu'), selObj=document.getElementById('fObj');
const mType=document.getElementById('mType'), btnType=document.getElementById('btnType'),
      popType=document.getElementById('popType'), typeSummary=document.getElementById('typeSummary'),
      clearAll=document.getElementById('clearAll'), cbAll=document.getElementById('cbAll');
const fLabel=document.getElementById('fLabel'), fBadges=document.getElementById('fBadges'), fOrigin=document.getElementById('fOrigin');

const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const nf=n=>n.toLocaleString();
// Show-filter names come from the checkboxes themselves, so the list lives in one place.
const TYPE_LABEL={};
popType.querySelectorAll('input[type=checkbox]').forEach(c=>{if(c!==cbAll)TYPE_LABEL[c.value]=c.parentNode.querySelector('.optl').textContent;});
// Salesforce describe types -> the names people see in Setup.
const TYPE_NAME={string:'Text',textarea:'Text Area',reference:'Lookup',boolean:'Checkbox',picklist:'Picklist',
  multipicklist:'Multi-Select Picklist',combobox:'Picklist (editable)',double:'Number',int:'Number',long:'Number',
  currency:'Currency',percent:'Percent',datetime:'Date/Time',date:'Date',time:'Time',id:'Record ID',url:'URL',
  phone:'Phone',email:'Email',address:'Address',location:'Geolocation',encryptedstring:'Text (Encrypted)',base64:'File'};
const KIND_NAME={autonumber:'Auto Number',masterdetail:'Master-Detail',externallookup:'External Lookup',
  indirectlookup:'Indirect Lookup',richtext:'Rich Text Area'};
function friendlyType(f){
  const t=(f.type||'').toLowerCase();
  let n=TYPE_NAME[t]||(f.type||'—');
  if(KIND_NAME[f.kind])return KIND_NAME[f.kind];
  if(t==='textarea'&&Number(f.len)>255)n='Long Text Area';
  if(f.kind==='rollup')return 'Roll-Up Summary ('+n+')';
  if(f.formula)return 'Formula ('+n+')';
  if((t==='string'||t==='textarea'||t==='encryptedstring')&&Number(f.len))n+=' ('+nf(Number(f.len))+')';
  return n;}
// A checkbox is never blank, so Salesforce marks every one required; that reads as wrong to a business user.
const isReq=f=>!!f.req&&f.type!=='boolean';
const byLabel=(a,b)=>(a.label||a.name||a.api).localeCompare(b.label||b.name||b.api,undefined,{sensitivity:'base'});
const uid=()=>'x'+Math.random().toString(36).slice(2);

function typeClass(t){t=(t||'').toLowerCase();
  if(t.includes('formula'))return'--c-formula';
  if(t==='reference'||t==='lookup'||t==='masterdetail'||t==='hierarchy')return'--c-ref';
  if(t.includes('picklist'))return'--c-pick';
  if(['double','int','currency','percent','number','long'].some(x=>t.includes(x)))return'--c-num';
  if(t.includes('date')||t.includes('time'))return'--c-date';
  if(t==='boolean'||t==='checkbox')return'--c-bool';
  if(t.includes('string')||t.includes('text')||t.includes('email')||t.includes('phone')||t.includes('url')||t.includes('area'))return'--c-text';
  return'--c-other';}

function orgIds(){return bu==='both'?ORDER:[bu];}
// rows: {org, o} — org is null in merged mode
function view(){
  const rows = bu==='both'
    ? COMBINED.map(o=>({org:null,o:o}))
    : ORGS[bu].data.map(o=>({org:bu,o:o}));
  return rows.sort((a,b)=>{
    const ra=PIN_RANK[a.o.api], rb=PIN_RANK[b.o.api];
    if(ra!==undefined||rb!==undefined){
      if(ra===undefined)return 1;
      if(rb===undefined)return -1;
      return ra-rb;
    }
    return byLabel(a.o,b.o);
  });
}
let VIEW=view(), VISIBLE=[];

function fieldMatches(f,ql){if(!ql)return true;
  return (f.name+' '+f.label+' '+f.type+' '+friendlyType(f)+' '+(f.desc||'')+' '+(f.help||'')+' '+(f.formula||'')+' '+(f.ref||[]).join(' ')+' '+(f.pick||[]).join(' ')).toLowerCase().includes(ql);}
// The one Setup field type a field is (keys match the Show checkboxes). Formula and
// roll-up win over the result type, as in Setup: a number formula is a Formula field.
function typeKey(f){
  const t=(f.type||'').toLowerCase(), k=f.kind||'';
  if(k==='rollup')return 'rollup';
  if(f.formula)return 'formula';
  if(k)return k;
  if(t==='reference')return 'lookup';
  if(t==='double'||t==='int'||t==='long')return 'number';
  if(t==='combobox')return 'picklist';
  if(t==='textarea')return Number(f.len)>255?'longtextarea':'textarea';
  return t;}
// Per-type counts beside each Show option, for the current org view (before other filters).
let countsFor=null;
function syncTypeCounts(){
  if(countsFor===bu)return;
  const n={};
  // counted the way passTypes matches: once per type either org's version has
  for(const r of VIEW)for(const f of r.o.fields){
    const ks=new Set(f._v?Object.keys(f._v).map(k=>typeKey(f._v[k])):[typeKey(f)]);
    ks.forEach(k=>{n[k]=(n[k]||0)+1;});}
  popType.querySelectorAll('.optn').forEach(s=>{const c=n[s.dataset.n]||0;
    s.textContent=nf(c);s.parentNode.classList.toggle('zero',!c);});
  countsFor=bu;}
// Badge filter. Org boxes are OR'd with each other; Differs and Required each narrow further.
// Org and Differs only mean something in the merged view, so single-org views ignore them.
function passBadges(f){
  if(!badgeSel.size)return true;
  if(bu==='both'){
    const orgPick=['both','sbuonly','xbuonly'].filter(k=>badgeSel.has(k));
    const orgs=f._orgs||[];
    if(orgPick.length&&!orgPick.includes(orgs.length>1?'both':orgs[0]+'only'))return false;
    if(badgeSel.has('differs')&&!(f._diffs&&f._diffs.length))return false;
  }
  if(badgeSel.has('required')&&!isReq(f))return false;
  if(badgeSel.has('managed')&&!packageOf(f))return false;
  return true;}
function passLabel(f){return !labelQ||(f.label||'').toLowerCase().includes(labelQ);}
// Custom = API name with a custom suffix: __c (incl. managed packages), __s (custom address parts), __pc (person account).
const isCustomField=f=>/__(c|s|pc)$/i.test(f.name||'');
// Managed-package fields carry a namespace prefix: ns__Field__c (or __pc), and ns__Field__Part__s for
// address parts. Plain custom address parts (Business__City__s) have one separator fewer, so they don't match.
function packageOf(f){
  const p=(f.name||'').split('__'), suf=p.length>1?p[p.length-1].toLowerCase():'';
  const need=suf==='s'?4:(suf==='c'||suf==='pc')?3:Infinity;
  return p.length>=need?p[0]:'';}
// Exactly one of: managed (from a package), custom (built in-house) or standard.
const originOf=f=>packageOf(f)?'managed':isCustomField(f)?'custom':'standard';
function passOrigin(f){return originSel==='all'||originOf(f)===originSel;}
function anyFieldFilter(){return typeSel.size>0||badgeSel.size>0||!!labelQ||originSel!=='all';}
function syncBadgeFilter(){
  fBadges.querySelectorAll('input').forEach(cb=>{
    const off=bu!=='both'&&cb.value!=='required'&&cb.value!=='managed';
    cb.disabled=off; cb.parentNode.classList.toggle('off',off);
    cb.parentNode.title=off?'Only applies when Org is Both orgs':'';});}
function passTypes(f){
  if(!passOrigin(f)||!passBadges(f)||!passLabel(f))return false;
  if(!typeSel.size)return true;
  // in merged mode a field qualifies if either org's version qualifies
  const variants=f._v?Object.keys(f._v).map(k=>f._v[k]):[f];
  return variants.some(v=>typeSel.has(typeKey(v)));}
function objPassesScope(o){return objScope==='both'||o.api===objScope;}
// Object picker: every object in the current org view, listed by label. The API name
// is shown only where two objects share a label, so the choices stay distinguishable.
// Rebuilt only when the org changes, not on every keystroke.
let pickerFor=null;
function fillObjPicker(){
  const rows=VIEW.map(r=>r.o);
  if(objScope!=='both'&&!rows.some(o=>o.api===objScope))objScope='both';
  if(pickerFor!==bu){
    const seen={};
    rows.forEach(o=>{const k=(o.label||o.api).toLowerCase();seen[k]=(seen[k]||0)+1;});
    const opt=o=>{const l=o.label||o.api;
      return '<option value="'+esc(o.api)+'">'+esc(seen[l.toLowerCase()]>1?l+' ('+o.api+')':l)+'</option>';};
    const key=rows.filter(o=>PIN_RANK[o.api]!==undefined), rest=rows.filter(o=>PIN_RANK[o.api]===undefined);
    selObj.innerHTML='<option value="both">All objects</option>'
      +(key.length?'<optgroup label="Key objects">'+key.map(opt).join('')+'</optgroup>':'')
      +'<optgroup label="All objects">'+rest.map(opt).join('')+'</optgroup>';
    pickerFor=bu;
  }
  selObj.value=objScope;}
function objMatchCount(o,ql){let n=0;for(const f of o.fields){if(passTypes(f)&&fieldMatches(f,ql))n++;}return n;}
function hl(text,ql){text=esc(text);if(!ql)return text;
  const i=text.toLowerCase().indexOf(ql);if(i<0)return text;
  return text.slice(0,i)+'<mark>'+text.slice(i,i+ql.length)+'</mark>'+text.slice(i+ql.length);}
function orgBadge(orgs){
  if(orgs.length>1) return '<span class="orgtag both" title="Exists in both SBU and XBU">Both</span>';
  return '<span class="orgtag '+orgs[0]+'" title="Exists in '+orgs[0].toUpperCase()+' only">'+orgs[0].toUpperCase()+'</span>';
}

function computeVisible(){
  const ql=query.toLowerCase(), anyFilter=anyFieldFilter();
  const out=[];
  for(const r of VIEW){
    if(!objPassesScope(r.o))continue;
    const mc=(ql||anyFilter)?objMatchCount(r.o,ql):r.o.fields.length;
    if(anyFilter&&mc===0)continue;
    if(ql&&mc===0&&!(r.o.api+' '+r.o.label).toLowerCase().includes(ql))continue;
    out.push({org:r.org,o:r.o,mc:mc});
  }
  return out;
}

function renderHeader(){
  const ids=orgIds();
  subEl.textContent = ids.length>1
    ? 'SBU + XBU Production · merged view · generated '+ORGS[ids[0]].meta.gen
    : ORGS[ids[0]].meta.name+' · '+ORGS[ids[0]].meta.sub+' · generated '+ORGS[ids[0]].meta.gen;
  const ql=query.toLowerCase(), filtering=!!ql||anyFieldFilter();
  let objs=0,cust=0,flds=0,dif=0;
  for(const {o} of VISIBLE){
    objs++; if(o.custom)cust++;
    for(const f of o.fields){
      if(filtering&&!(passTypes(f)&&fieldMatches(f,ql)))continue;
      flds++; if(f._diffs&&f._diffs.length)dif++;
    }
  }
  statsEl.innerHTML=
    '<div class="stat"><b>'+nf(objs)+'</b><span>Objects</span></div>'+
    '<div class="stat"><b>'+nf(cust)+'</b><span>Custom objects</span></div>'+
    '<div class="stat"><b>'+nf(flds)+'</b><span>Fields</span></div>'+
    (bu==='both'?'<div class="stat" title="Fields set up differently in SBU and XBU"><b>'+nf(dif)+'</b><span>Differ SBU vs XBU</span></div>':'');
  clearAll.hidden=!(bu!=='both'||objScope!=='both'||anyFieldFilter()||!!query);
}

function objRow(r,ql,anyFilter){
  const o=r.o, mc=r.mc;
  const cur=(pinnedObj&&pinnedObj.api===o.api&&pinnedObj.org===r.org)?'true':'false';
  const isMatch=(ql||anyFilter)&&mc>0;
  return '<button class="obj" role="listitem" aria-current="'+cur+'" data-api="'+esc(o.api)+'" data-org="'+(r.org||'')+'">'
    +(bu==='both'?orgBadge(o.orgs):'')
    // custom/standard tag sits on the second line so it never squeezes the label
    +'<span class="otext"><span class="olabel">'+hl(o.label||o.api,ql)+'</span><span class="osub">'
    +(o.custom?'<span class="tag custom" title="Custom object">Custom</span>':'<span class="tag std" title="Standard Salesforce object">Standard</span>')
    +(o.label&&o.label!==o.api?'<span class="oapi">'+hl(o.api,ql)+'</span>':'')+'</span></span>'
    +(bu==='both'&&o.nDiff?'<span class="diffchip" title="'+o.nDiff+' field'+(o.nDiff===1?'':'s')+' set up differently in SBU and XBU">'+o.nDiff+' differ</span>':'')
    +'<span class="count'+(isMatch?' match':'')+'" title="'+mc+((ql||anyFilter)?' matching':'')+' field'+(mc===1?'':'s')+'">'+mc+'</span></button>';
}

function renderList(){
  const ql=query.toLowerCase(), anyFilter=anyFieldFilter();
  const pin=VISIBLE.filter(r=>PIN_RANK[r.o.api]!==undefined);
  const rest=VISIBLE.filter(r=>PIN_RANK[r.o.api]===undefined);
  let html='';
  if(pin.length) html+='<div class="grouphead">Key objects</div>'+pin.map(r=>objRow(r,ql,anyFilter)).join('');
  if(rest.length) html+='<div class="grouphead">All objects</div>'+rest.map(r=>objRow(r,ql,anyFilter)).join('');
  list.innerHTML=html||'<div class="empty">No objects match.</div>';
}

function dval(f,attr){
  if(!f)return '—';
  if(attr==='req')return isReq(f)?'Yes':'No';
  if(attr==='uniq'||attr==='extId')return f[attr]?'Yes':'No';
  if(attr==='type')return friendlyType(f);
  if(attr==='ref')return (f.ref&&f.ref.length)?f.ref.join(', '):'—';
  if(attr==='pick')return (f.pick?f.pick.length:0)+' values';
  if(attr==='formula')return 'see below';
  return String(f[attr]||'—');
}
function diffBlock(f){
  const [a,b]=[ORDER[0],ORDER[1]];
  let rows='';
  for(const k of f._diffs){
    rows+='<div class="diffrow"><span class="dk">'+esc(CMP_LABEL[k]||k)+'</span><span class="dvals">'
      +'<span class="dv sbu"><i>SBU</i>'+esc(dval(f._v[a],k))+'</span>'
      +'<span class="dv xbu"><i>XBU</i>'+esc(dval(f._v[b],k))+'</span></span></div>';
  }
  // long values get an expandable side-by-side
  const long=f._diffs.filter(k=>k==='formula'||k==='pick');
  if(long.length){
    const id=uid();
    rows+='<div class="diffrow"><span class="dk"></span><span class="dvals">'
      +'<button class="toggle" type="button" onclick="var e=document.getElementById(\\''+id+'\\');e.classList.toggle(\\'hidden\\')">compare values</button></span></div>'
      +'<div id="'+id+'" class="cmp hidden">';
    for(const k of long){
      for(const id2 of [a,b]){
        const v=f._v[id2];
        rows+='<div><div class="cl '+id2+'">'+id2.toUpperCase()+' · '+esc(CMP_LABEL[k])+'</div>'
          +(k==='formula'
            ? '<div class="formula">'+esc(v&&v.formula?v.formula:'—')+'</div>'
            : '<div class="pills">'+((v&&v.pick&&v.pick.length)?v.pick.map(p=>'<span class="pill">'+esc(p)+'</span>').join(''):'<span class="pill">—</span>')+'</div>')
          +'</div>';
      }
    }
    rows+='</div>';
  }
  return '<div class="kv"><span class="k">SBU vs XBU</span><span class="v diffs">'+rows+'</span></div>';
}

function fieldCard(f,ql,withObj,objApi,objLabel){
  const tc=f.formula?'--c-formula':typeClass(f.type);
  const merged=!!f._orgs;
  const differs=merged&&f._diffs.length>0;
  let attrs='';
  if(f.uniq)attrs+='<span class="attr uniq" title="No two records can share the same value">Unique</span>';
  if(f.extId)attrs+='<span class="attr ext" title="Used to match records from imports and integrations">External Id</span>';
  let det='';
  if(differs)det+=diffBlock(f);
  if(f.ref&&f.ref.length)det+='<div class="kv"><span class="k">Looks up to</span><span class="v reflist">'+f.ref.map(r=>'<span>'+esc(r)+'</span>').join('')+'</span></div>';
  if(f.pick&&f.pick.length){const id=uid();
    det+='<div class="kv"><span class="k">Values</span><span class="v"><button class="toggle" type="button" onclick="var e=document.getElementById(\\''+id+'\\');e.classList.toggle(\\'hidden\\')">'+f.pick.length+' values</button>'
      +(f.gvs?' <span style="color:var(--faint)">· global value set <span style="font-family:var(--mono)">'+esc(f.gvs)+'</span></span>':'')
      +'<div id="'+id+'" class="pills hidden" style="margin-top:5px">'+f.pick.map(p=>'<span class="pill">'+esc(p)+'</span>').join('')+'</div></span></div>';}
  else if(f.gvs)det+='<div class="kv"><span class="k">Values</span><span class="v">Global value set: <span style="font-family:var(--mono)">'+esc(f.gvs)+'</span></span></div>';
  if(f.formula){const id=uid();
    det+='<div class="kv"><span class="k">Formula</span><span class="v" style="flex:1"><button class="toggle" type="button" onclick="var e=document.getElementById(\\''+id+'\\');e.classList.toggle(\\'hidden\\')">show</button>'
      +'<div id="'+id+'" class="formula hidden" style="margin-top:5px">'+esc(f.formula)+'</div></span></div>';}
  if(f.desc)det+='<div class="kv"><span class="k">Description</span><span class="v desc">'+hl(f.desc,ql)+'</span></div>';
  if(f.help)det+='<div class="kv"><span class="k">Help Text</span><span class="v help">'+hl(f.help,ql)+'</span></div>';
  // every value is labelled, so a reader never has to guess which name is the label and which the API name
  const kv=(k,v)=>'<div class="kv"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>';
  const pkg=packageOf(f);
  // left rail: which org(s) the field is in, and whether SBU and XBU set it up differently
  const rail='<div class="frail">'+orgBadge(merged?f._orgs:[bu])
    +(isReq(f)?'<span class="attr req" title="Must have a value before the record can be saved">Required</span>':'')
    +(pkg?'<span class="mgdchip" title="Installed by the '+esc(pkg)+' managed package. It cannot be deleted, and the package controls most of its settings.">Managed</span>'
      :isCustomField(f)?'<span class="srcchip custom" title="Custom field built in-house">Custom Field</span>'
      :'<span class="srcchip std" title="Standard field that comes with Salesforce">Standard Field</span>')
    +(differs?'<span class="diffchip" title="Set up differently in SBU and XBU — see below">Differs</span>':'')+'</div>';
  return '<div class="field'+(differs?' differs':'')+(isReq(f)?' isreq':'')+'">'+rail+'<div class="fdetail">'
    +(withObj?kv('Object',esc(objLabel||objApi)+(objLabel&&objLabel!==objApi?' <span class="fnameobj">('+esc(objApi)+')</span>':'')):'')
    +'<div class="kv"><span class="k">Field Label</span><span class="v frow"><span class="flabel">'+hl(f.label||f.name,ql)+'</span>'
      +'<span class="fbadges">'+attrs+'</span></span></div>'
    +kv('API Name','<span class="fapi">'+hl(f.name,ql)+'</span>')
    +(pkg?kv('Package','<span class="fapi">'+esc(pkg)+'</span>'):'')
    +kv('Type','<span class="type" title="Salesforce type: '+esc(f.type||'—')+'" style="color:var('+tc+');border-color:var('+tc+')">'+esc(friendlyType(f))+'</span>')
    +det+'</div></div>';
}

function renderMain(){
  const ql=query.toLowerCase(), anyFilter=anyFieldFilter();
  const totalFieldsN=VIEW.reduce((a,r)=>a+r.o.fields.length,0);
  if(pinnedObj){
    const row=VISIBLE.find(r=>r.o.api===pinnedObj.api&&r.org===pinnedObj.org);
    if(!row){main.innerHTML='<div class="empty">'+(objScope!=='both'
      ?'No fields in this object match the current search or filter.'
      :'That object isn’t in the current filter.')+'</div>';return;}
    const o=row.o;
    const fields=o.fields.filter(f=>passTypes(f)&&fieldMatches(f,ql)).sort(byLabel);
    let meta=fields.length+' of '+o.fields.length+' fields'+(ql?' matching “'+esc(query)+'”':'');
    if(bu==='both'){
      meta+= ' · '+(o.orgs.length>1?'in SBU and XBU':'only in '+o.orgs[0].toUpperCase());
      if(o.nDiff)meta+=' · '+o.nDiff+' field'+(o.nDiff===1?'':'s')+' differ';
    }
    let h='<div class="mhead">'+(bu==='both'?orgBadge(o.orgs):'')+'<h2>'+esc(o.label||o.api)+'</h2>'+(o.label&&o.label!==o.api?'<span class="mapi">'+esc(o.api)+'</span>':'')
      +'<span class="tag '+(o.custom?'custom':'std')+'">'+(o.custom?'Custom':'Standard')+'</span></div>'
      +'<div class="mmeta">'+meta+'</div>';
    h+=fields.length?fields.map(f=>fieldCard(f,ql,false,o.api,o.label)).join(''):'<div class="empty">No fields match the current filter.</div>';
    main.innerHTML=h;main.scrollTop=0;return;
  }
  if(!ql&&!anyFilter){
    main.innerHTML='<div class="empty">Select an object on the left, or search across all '+nf(totalFieldsN)+' fields.</div>';return;
  }
  let rows=[],truncated=false;
  for(const {o} of VISIBLE){
    for(const f of o.fields){if(passTypes(f)&&fieldMatches(f,ql)){rows.push([o,f]);if(rows.length>=CAP){truncated=true;break;}}}
    if(truncated)break;}
  const scopeTxt=bu==='both'?'SBU + XBU merged':ORGS[bu].meta.name;
  let h='<div class="mhead"><h2 style="font-family:var(--sans)">Field results</h2></div>'
    +'<div class="mmeta">'+rows.length+(truncated?'+':'')+' fields'+(query?' matching “'+esc(query)+'”':'')+' · '+esc(scopeTxt)+'</div>';
  if(truncated)h+='<div class="note">Showing first '+CAP+'. Refine the search or open a single object for the full list.</div>';
  h+=rows.length?rows.map(([o,f])=>fieldCard(f,ql,true,o.api,o.label)).join(''):'<div class="empty">No fields match.</div>';
  main.innerHTML=h;main.scrollTop=0;
}

function syncTypeSummary(){
  const sel=[...typeSel];
  cbAll.checked=sel.length===0;
  typeSummary.textContent = !sel.length ? 'All fields'
    : sel.length<=2 ? sel.map(t=>TYPE_LABEL[t]).join(', ')
    : sel.length+' types selected';
}
function render(){VIEW=view();fillObjPicker();syncBadgeFilter();syncTypeCounts();
  // a picked object stays open, so search and field filters apply within it
  if(objScope!=='both')pinnedObj={api:objScope,org:bu==='both'?null:bu};
  VISIBLE=computeVisible();renderHeader();renderList();renderMain();}

list.addEventListener('click',e=>{const b=e.target.closest('.obj');if(!b)return;
  pinnedObj={api:b.dataset.api,org:b.dataset.org||null};render();});
q.addEventListener('input',()=>{query=q.value.trim();pinnedObj=null;render();});
selBu.addEventListener('change',()=>{bu=selBu.value;pinnedObj=null;render();list.scrollTop=0;});
selObj.addEventListener('change',()=>{objScope=selObj.value;pinnedObj=null;render();list.scrollTop=0;});

function setPop(open){mType.dataset.open=open?'true':'false';popType.hidden=!open;btnType.setAttribute('aria-expanded',open?'true':'false');}
btnType.addEventListener('click',e=>{e.stopPropagation();setPop(popType.hidden);});
popType.addEventListener('click',e=>e.stopPropagation());
document.addEventListener('click',()=>setPop(false));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!popType.hidden){setPop(false);btnType.focus();}});
cbAll.addEventListener('change',()=>{
  typeSel.clear();
  popType.querySelectorAll('input[type=checkbox]').forEach(c=>{if(c!==cbAll)c.checked=false;});
  cbAll.checked=true;syncTypeSummary();pinnedObj=null;render();});
popType.querySelectorAll('input[type=checkbox]').forEach(cb=>{ if(cb===cbAll)return;
  cb.addEventListener('change',()=>{
    cb.checked?typeSel.add(cb.value):typeSel.delete(cb.value);
    syncTypeSummary();pinnedObj=null;render();});});
clearAll.addEventListener('click',()=>{
  bu='both';objScope='both';typeSel.clear();query='';pinnedObj=null;
  badgeSel.clear();labelQ='';fLabel.value='';originSel='all';fOrigin.value='all';fBadges.querySelectorAll('input').forEach(c=>c.checked=false);
  selBu.value='both';selObj.value='both';q.value='';
  popType.querySelectorAll('input[type=checkbox]').forEach(c=>c.checked=(c===cbAll));
  syncTypeSummary();render();list.scrollTop=0;});

// these two keep the open object open, so they filter within it
fLabel.addEventListener('input',()=>{labelQ=fLabel.value.trim().toLowerCase();render();});
fOrigin.addEventListener('change',()=>{originSel=fOrigin.value;render();});
fBadges.querySelectorAll('input').forEach(cb=>cb.addEventListener('change',()=>{
  cb.checked?badgeSel.add(cb.value):badgeSel.delete(cb.value);render();}));

const root=document.documentElement,tb=document.getElementById('themeBtn');
tb.addEventListener('click',()=>{const cur=root.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
  root.setAttribute('data-theme',cur==='dark'?'light':'dark');});

syncTypeSummary();render();
})();
</script>
<script>
// Inflate the payload, set window.P, then run the explorer source verbatim.
(function(){
  function fail(msg){
    var m=document.getElementById('main');
    if(m)m.innerHTML='<div class="empty">'+msg+'</div>';
  }
  var b64=document.getElementById('payload').textContent.trim();
  if(typeof DecompressionStream!=='function'){
    fail('This browser can\\u2019t decompress the field data (DecompressionStream unsupported).');return;
  }
  var bin=Uint8Array.from(atob(b64),function(c){return c.charCodeAt(0);});
  new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    .then(function(text){
      window.P=JSON.parse(text);
      var s=document.createElement('script');
      s.textContent=document.getElementById('explorer').textContent;
      document.body.appendChild(s);
    })
    .catch(function(e){fail('Could not load the field data: '+e.message);});
})();
</script>
<script>
(function(){
  var cv=document.getElementById('changesView'), av=document.getElementById('appView');
  var root=document.documentElement;
  function show(dict){
    cv.hidden=dict; av.hidden=!dict;
    if(dict){var q=document.getElementById('q'); if(q)q.focus();}
    else cv.scrollTop=0;
  }
  document.getElementById('toDict').addEventListener('click',function(){show(true);});
  document.getElementById('toChanges').addEventListener('click',function(){show(false);});
  document.getElementById('themeBtn2').addEventListener('click',function(){
    var cur=root.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
    root.setAttribute('data-theme',cur==='dark'?'light':'dark');
  });
  // View in dictionary: open the field's object, then search for the field inside it
  cv.addEventListener('click',function(e){
    var b=e.target.closest('.cview'); if(!b)return;
    show(true);
    var o=document.getElementById('fObj'), q=document.getElementById('q'), fl=document.getElementById('fLabel');
    // API name alone also matches formulas that reference the field, so pin the label too
    if(fl){fl.value=b.dataset.label||'';fl.dispatchEvent(new Event('input'));}
    if(o&&[].some.call(o.options,function(x){return x.value===b.dataset.obj;})){o.value=b.dataset.obj;o.dispatchEvent(new Event('change'));}
    if(q){q.value=b.dataset.field;q.dispatchEvent(new Event('input'));}
  });
  // Changes filters: Org / Type of change / Object. Rows carry data-orgs + data-obj;
  // sections and the "newly visible" block carry data-kind.
  var fOrg=document.getElementById('chOrg'), fKind=document.getElementById('chKind'),
      fObj=document.getElementById('chObj'), fClr=document.getElementById('chClear');
  function applyChanges(){
    var org=fOrg.value, kind=fKind.value, obj=fObj.value, any=org!=='all'||kind!=='all'||obj!=='all';
    [].forEach.call(cv.querySelectorAll('[data-kind]'),function(sec){
      var kindOk=kind==='all'||sec.dataset.kind===kind;
      // coverage notes aren't about any one org or object, so only show them unfiltered
      if(sec.dataset.kind==='coverage'){sec.hidden=any;return;}
      var rows=sec.querySelectorAll('li[data-obj]'), n=0;
      [].forEach.call(rows,function(r){
        var ok=(org==='all'||r.dataset.orgs.split(' ').indexOf(org)>=0)&&(obj==='all'||r.dataset.obj===obj);
        r.hidden=!ok; if(ok)n++;});
      [].forEach.call(sec.querySelectorAll('.cobj'),function(g){g.hidden=!g.querySelector('li:not([hidden])');});
      var c=sec.querySelector('h2 .cnt, summary .cnt2'); if(c)c.textContent=n.toLocaleString('en-US');
      var none=sec.querySelector('.cfnone'); if(none)none.hidden=!(rows.length&&!n);
      // the "newly visible" block is extra detail: drop it rather than show it empty
      sec.hidden=!kindOk||(sec.tagName==='DETAILS'&&!n);
    });
    [].forEach.call(cv.querySelectorAll('.csum[data-org]'),function(s){s.hidden=org!=='all'&&s.dataset.org!==org;});
    fClr.hidden=!any;
  }
  [fOrg,fKind,fObj].forEach(function(s){s.addEventListener('change',applyChanges);});
  fClr.addEventListener('click',function(){fOrg.value='all';fKind.value='all';fObj.value='all';applyChanges();});
  if(location.hash==='#dictionary')show(true);
})();
</script>
`;

fs.writeFileSync(`${SC}/salesforce-data-dictionary.html`, HTML);
console.log('wrote', `${SC}/salesforce-data-dictionary.html`, (HTML.length / 1e6).toFixed(2), 'MB');
