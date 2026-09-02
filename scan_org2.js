// Step 2+3: EntityDefinition-driven object list, described in batches of 25,
// streamed to the per-org data file so no batch is held in memory past its write.
// usage: node scan_org2.js <sfAlias> <prefix> <outFile> <mdDir>
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const OUT = __dirname.split(String.fromCharCode(92)).join('/');
const API = 'v62.0';
const BATCH = 25;
const [ALIAS, PREFIX, OUTFILE, MDDIR] = process.argv.slice(2);
if (!ALIAS || !PREFIX || !OUTFILE) {
  console.error('usage: node scan_org2.js <alias> <prefix> <outFile> <mdDir>');
  process.exit(1);
}

const sf = (...a) => execFileSync(process.execPath,
  ['C:/Program Files/sf/client/bin/run.js', ...a],
  { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });

const org = JSON.parse(sf('org', 'display', '--json', '-o', ALIAS)).result;
const I = org.instanceUrl;
let T;
try {
  const j = JSON.parse(sf('org', 'auth', 'show-access-token', '--json', '-o', ALIAS));
  T = typeof j.result === 'string' ? j.result : j.result && j.result.accessToken;
} catch { T = org.accessToken; }
if (!T || !/^00D/.test(T)) { console.error('FATAL ' + ALIAS + ': no usable access token'); process.exit(1); }
const H = { Authorization: 'Bearer ' + T };

async function rest(p) {
  const r = await fetch(I + p, { headers: H });
  if (!r.ok) throw new Error(r.status + ' ' + p + ' ' + (await r.text()).slice(0, 300));
  return r.json();
}
async function qAll(p0) {
  let p = p0, o = [];
  for (;;) {
    const j = await rest(p);
    o = o.concat(j.records || []);
    if (j.done || !j.nextRecordsUrl) break;
    p = j.nextRecordsUrl;
  }
  return o;
}
const soql = q => '/services/data/' + API + '/query/?q=' + encodeURIComponent(q);
const tq = q => '/services/data/' + API + '/tooling/query/?q=' + encodeURIComponent(q);
async function pool(items, limit, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    for (;;) { const k = i++; if (k >= items.length) return; res[k] = await fn(items[k], k); }
  }));
  return res;
}

// step 2 exclusions
const EXCL = /(Share|History|Feed|ChangeEvent|Tag|Rule|RuleShare)$|__e$/;

(async () => {
  console.log('org:', org.username, org.id);

  // ---- object list (dynamic, per step 2) ----
  const ents = await qAll(soql(
    'SELECT QualifiedApiName, Label FROM EntityDefinition ' +
    'WHERE IsCustomizable = true AND IsQueryable = true ORDER BY QualifiedApiName'));
  const keep = ents.filter(e => !EXCL.test(e.QualifiedApiName));
  console.log('EntityDefinition: ' + ents.length + ' | after exclusions: ' + keep.length);
  fs.writeFileSync(OUT + '/' + PREFIX + '_entities.json',
    JSON.stringify(keep.map(e => ({ api: e.QualifiedApiName, label: e.Label }))));

  // ---- field descriptions / help from Tooling (one pass, before batching) ----
  const cf = await qAll(tq('SELECT DeveloperName, NamespacePrefix, Description, InlineHelpText, ' +
    'EntityDefinition.QualifiedApiName FROM CustomField'));
  const descMap = {};
  for (const c of cf) {
    const obj = c.EntityDefinition ? c.EntityDefinition.QualifiedApiName : null;
    if (!obj) continue;
    descMap[obj + '.' + (c.NamespacePrefix ? c.NamespacePrefix + '__' : '') + c.DeveloperName + '__c'] =
      { desc: c.Description || '', help: c.InlineHelpText || '' };
  }
  console.log('tooling custom fields:', cf.length, '| desc map:', Object.keys(descMap).length);

  // ---- global value sets ----
  const gl = await rest(tq('SELECT Id, DeveloperName FROM GlobalValueSet'));
  const GVS = {};
  for (const g of gl.records) {
    const one = await rest('/services/data/' + API + '/tooling/sobjects/GlobalValueSet/' + g.Id);
    GVS[g.DeveloperName] = ((one.Metadata && one.Metadata.customValue) || []).map(v => v.valueName ?? v.fullName);
  }
  console.log('global value sets:', Object.keys(GVS).length);

  const byOrdered = {}, bySorted = {};
  for (const [name, vals] of Object.entries(GVS)) {
    if (!vals.length) continue;
    (byOrdered[JSON.stringify(vals)] ??= []).push(name);
    (bySorted[JSON.stringify([...vals].sort())] ??= []).push(name);
  }
  function inferGvs(pick) {
    if (!pick.length) return '';
    const o = byOrdered[JSON.stringify(pick)];
    if (o && o.length === 1) return o[0];
    const s = bySorted[JSON.stringify([...pick].sort())];
    if (s && s.length === 1) return s[0];
    return o && o.length ? o[0] : '';
  }
  function walk(d, filt) {
    const o = [];
    if (!fs.existsSync(d)) return o;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) o.push(...walk(p, filt)); else if (filt(p)) o.push(p);
    }
    return o;
  }
  const exactGvs = {}, retrieved = new Set();
  for (const p of walk(MDDIR || '', f => f.endsWith('.field-meta.xml'))) {
    const key = path.basename(path.dirname(path.dirname(p))) + '.' +
      path.basename(p).replace('.field-meta.xml', '');
    retrieved.add(key);
    const m = /<valueSetName>([\s\S]*?)<\/valueSetName>/.exec(fs.readFileSync(p, 'utf8'));
    if (m) exactGvs[key] = m[1].trim();
  }

  const len = f => (f.length > 0 ? String(f.length) : (f.precision > 0 ? String(f.precision) : ''));
  let exact = 0, inferred = 0;

  function shape(d) {
    return {
      api: d.name, label: d.label, custom: !!d.custom,
      fields: d.fields.map(f => {
        const pick = (f.picklistValues || []).map(v => v.value);
        const dm = descMap[d.name + '.' + f.name] || {};
        const key = d.name + '.' + f.name;
        let gvs = '';
        if (f.type === 'picklist' || f.type === 'multipicklist') {
          if (key in exactGvs) { gvs = exactGvs[key]; exact++; }
          else if (!retrieved.has(key)) { gvs = inferGvs(pick); if (gvs) inferred++; }
        }
        return {
          name: f.name, label: f.label, type: f.type, len: len(f),
          req: !f.nillable, uniq: !!f.unique, extId: !!f.externalId,
          formula: f.calculatedFormula || '', desc: dm.desc || '',
          help: f.inlineHelpText || dm.help || '',
          ref: f.referenceTo || [], pick, gvs
        };
      })
    };
  }

  // ---- describe in batches of 25, streaming each batch to the file ----
  // EntityDefinition already came back ORDER BY QualifiedApiName, which matches
  // the api-sorted order build_data.js used to produce.
  const fd = fs.openSync(OUTFILE, 'w');
  fs.writeSync(fd, '[');
  let first = true, nObj = 0, nField = 0;
  const failed = [];
  const nBatch = Math.ceil(keep.length / BATCH);

  for (let i = 0; i < keep.length; i += BATCH) {
    const slice = keep.slice(i, i + BATCH);
    const got = (await pool(slice, 8, async s => {
      try { return await rest('/services/data/' + API + '/sobjects/' + s.QualifiedApiName + '/describe'); }
      catch (e) { failed.push(s.QualifiedApiName + ': ' + e.message.slice(0, 60)); return null; }
    })).filter(Boolean);

    let chunk = '';
    for (const d of got) {
      const o = shape(d);
      nObj++; nField += o.fields.length;
      chunk += (first ? '' : ',') + JSON.stringify(o);
      first = false;
    }
    if (chunk) fs.writeSync(fd, chunk);   // batch is on disk before the next describe starts
    process.stdout.write('\r  batch ' + (Math.floor(i / BATCH) + 1) + '/' + nBatch +
      '  objects ' + nObj + '  fields ' + nField + '   ');
  }
  fs.writeSync(fd, ']');
  fs.closeSync(fd);

  console.log('\n' + PREFIX + ': ' + nObj + ' objects, ' + nField + ' fields | gvs ' +
    exact + ' exact, ' + inferred + ' inferred');
  if (failed.length) {
    console.log('  describe failures (' + failed.length + '):');
    failed.slice(0, 25).forEach(f => console.log('   ', f));
  }
  console.log('wrote', OUTFILE);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
