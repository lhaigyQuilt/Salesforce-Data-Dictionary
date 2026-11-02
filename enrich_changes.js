// Annotate changes.json with:
//  - each added field's real CustomField CreatedDate + CreatedBy, so the page can
//    distinguish "created since the last run" from "existed already but only became
//    visible to the scan" (e.g. field-level security granted later), and say who added it.
//  - each changed field's most likely editor, matched from Setup Audit Trail (falling
//    back to the field's CustomField LastModifiedBy, marked as approximate, when no
//    matching audit-trail entry is found in the diff window).
//  - each removed field's deleter, matched from Setup Audit Trail (the CustomField row
//    is gone by the time this runs, so Audit Trail is the only source).
const { execFileSync } = require('child_process');
const fs = require('fs');
const OUT = __dirname.split(String.fromCharCode(92)).join('/');
const API = 'v62.0';
const PREV = process.argv[2] || '2026-08-25';

const sf = (...a) => execFileSync(process.execPath,
  ['C:/Program Files/sf/client/bin/run.js', ...a],
  { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });

async function tokenFor(alias) {
  const org = JSON.parse(sf('org', 'display', '--json', '-o', alias)).result;
  let T;
  try {
    const j = JSON.parse(sf('org', 'auth', 'show-access-token', '--json', '-o', alias));
    T = typeof j.result === 'string' ? j.result : j.result && j.result.accessToken;
  } catch { T = org.accessToken; }
  return { I: org.instanceUrl, H: { Authorization: 'Bearer ' + T } };
}

async function soqlAll(I, H, soql, tooling) {
  let p = '/services/data/' + API + '/' + (tooling ? 'tooling/' : '') + 'query/?q=' + encodeURIComponent(soql);
  const out = [];
  for (;;) {
    const r = await fetch(I + p, { headers: H });
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    out.push(...(j.records || []));
    if (j.done || !j.nextRecordsUrl) break;
    p = j.nextRecordsUrl;
  }
  return out;
}

// Setup Audit Trail Display text only ever names the field/object by LABEL, never by
// API name, so matching has to go through changes.json's own `label` (and `obj`'s
// current/previous label where the row gives one).
const RX = {
  createdCustom: /^Created custom field:?\s+(.+?)\s*\([^)]*\)(?:\s+on\s+(.+))?$/i,
  changedFormula: /^Changed formula of\s+(.+?)\s+custom field on\s+(.+?)\s+from/i,
  deletedCustom: /^(?:Permanently )?[Dd]eleted custom field\s+(.+?)(?:\s+from\s+(.+))?$/i,
  pickAdded: /to\s+(.+?)\s+picklist/i,
  pickReordered: /^Reordered\s+(.+?)\s+picklist/i,
  pickRenamed: /^Changed\s+(.+?)\s+picklist value'?s?\s+(?:API name\s+)?from/i,
};

function parseAuditRow(row) {
  const d = row.Display || '';
  let m;
  if (/^(createdCF|createdCFFormula|createdCFLookup|createdCFMasterDetail|createdCF_RSF)(Custom)?$/.test(row.Action)) {
    m = d.match(RX.createdCustom);
    if (m) return { kind: 'created', label: m[1].trim(), objLabel: m[2] ? m[2].trim() : null };
  }
  if (row.Action === 'changedCFFormulaCustom' || row.Action === 'changedCFFormula') {
    m = d.match(RX.changedFormula);
    if (m) return { kind: 'changed', label: m[1].trim(), objLabel: m[2].trim() };
  }
  if (/^(deletedCF|hardDeletedCF)(Custom)?$/.test(row.Action)) {
    m = d.match(RX.deletedCustom);
    if (m) return { kind: 'deleted', label: m[1].trim(), objLabel: m[2] ? m[2].trim() : null };
  }
  if (row.Action === 'createdPicklistWithColor' || row.Action === 'changedPicklist') {
    m = d.match(RX.pickAdded);
    if (m) return { kind: 'changed', label: m[1].trim(), objLabel: null };
  }
  if (row.Action === 'changedPicklistSort' || row.Action === 'changedPicklistSortCustom') {
    m = d.match(RX.pickReordered);
    if (m) return { kind: 'changed', label: m[1].trim(), objLabel: null };
  }
  if (row.Action === 'changedPicklistValueApiName' || row.Action === 'changedPicklistDefault') {
    m = d.match(RX.pickRenamed);
    if (m) return { kind: 'changed', label: m[1].trim(), objLabel: null };
  }
  return null;
}

// Index parsed audit rows for lookup by (objLabel, label) when available, else by
// label alone (used only when that label is unambiguous within the window).
function buildAuditIndex(rows) {
  const byObjLabel = new Map(), byLabel = new Map();
  for (const row of rows) {
    const parsed = parseAuditRow(row);
    if (!parsed || !row.CreatedBy) continue;
    const entry = { who: row.CreatedBy.Name, date: row.CreatedDate.slice(0, 10), kind: parsed.kind };
    const lk = parsed.label.toLowerCase();
    if (parsed.objLabel) {
      const k = parsed.objLabel.toLowerCase() + '|' + lk;
      if (!byObjLabel.has(k)) byObjLabel.set(k, []);
      byObjLabel.get(k).push(entry);
    }
    if (!byLabel.has(lk)) byLabel.set(lk, []);
    byLabel.get(lk).push(entry);
  }
  return { byObjLabel, byLabel };
}

// Most recent matching entry of the given kind. Display text that names the object
// (created/deleted/formula-changed entries) is trusted directly. Picklist-value entries
// never name the object, so those are only trusted when `label` is unique across the
// whole org's current schema (fieldLabelCount) — otherwise "Status" on fifty different
// objects would all get attributed to whoever last touched any one "Status" field.
function lookupAudit(index, objLabel, label, kind, fieldLabelCount) {
  const lk = String(label || '').toLowerCase();
  const exact = objLabel ? index.byObjLabel.get(objLabel.toLowerCase() + '|' + lk) : null;
  let pool;
  if (exact && exact.length) pool = exact;
  else if ((fieldLabelCount.get(lk) || 0) <= 1) pool = index.byLabel.get(lk) || [];
  else return null; // ambiguous label, no object named in the audit entry — don't guess
  const matches = pool.filter(e => e.kind === kind);
  if (!matches.length) return null;
  return matches.sort((a, b) => (a.date < b.date ? 1 : -1))[0];
}

(async () => {
  const ch = JSON.parse(fs.readFileSync(OUT + '/changes.json', 'utf8'));
  for (const [alias, prefix] of [['production', 'sbu'], ['xbu', 'xbu']]) {
    const { I, H } = await tokenFor(alias);

    const cfRows = await soqlAll(I, H,
      'SELECT DeveloperName, NamespacePrefix, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name, ' +
      'EntityDefinition.QualifiedApiName FROM CustomField', true);
    const created = {}, lastMod = {};
    for (const c of cfRows) {
      const obj = c.EntityDefinition ? c.EntityDefinition.QualifiedApiName : null;
      if (!obj) continue;
      const key = obj + '.' + (c.NamespacePrefix ? c.NamespacePrefix + '__' : '') + c.DeveloperName + '__c';
      created[key] = { date: c.CreatedDate.slice(0, 10), by: c.CreatedBy ? c.CreatedBy.Name : null };
      lastMod[key] = { date: c.LastModifiedDate.slice(0, 10), by: c.LastModifiedBy ? c.LastModifiedBy.Name : null };
    }

    const auditRows = await soqlAll(I, H,
      "SELECT Action, Display, CreatedDate, CreatedBy.Name FROM SetupAuditTrail WHERE CreatedDate >= " + PREV + "T00:00:00Z ORDER BY CreatedDate DESC", false);
    const auditIndex = buildAuditIndex(auditRows);

    // How many (object, field) pairs share each label, and each object's label, straight
    // from this run's own snapshot — used so a generic label like "Status" never gets
    // attributed via a picklist-value audit entry that doesn't name its object.
    const fieldLabelCount = new Map(), objLabelByApi = new Map();
    for (const o of JSON.parse(fs.readFileSync(OUT + '/' + prefix + '_data.json', 'utf8'))) {
      objLabelByApi.set(o.api, o.label);
      for (const fl of o.fields) {
        const lk = String(fl.label || fl.name).toLowerCase();
        fieldLabelCount.set(lk, (fieldLabelCount.get(lk) || 0) + 1);
      }
    }
    // Removed fields no longer exist in this run's snapshot, so count each of them in
    // too (each is necessarily distinct from anything still in the snapshot above) —
    // otherwise a label that existed only on the deleted field would look unique by
    // coincidence rather than by fact.
    for (const f of ch[prefix].fRemoved) {
      const lk = String(f.label || f.field).toLowerCase();
      fieldLabelCount.set(lk, (fieldLabelCount.get(lk) || 0) + 1);
    }

    let inWindow = 0, preexisting = 0, unknown = 0;
    for (const f of ch[prefix].fAdded) {
      const d = created[f.obj + '.' + f.field];
      f.created = d ? d.date : null;
      f.createdBy = d ? d.by : null;
      if (!d) unknown++;
      else if (d.date > PREV) { f.newInWindow = true; inWindow++; }
      else { f.newInWindow = false; preexisting++; }
    }
    ch[prefix].addedCreatedInWindow = inWindow;
    ch[prefix].addedPreexisting = preexisting;
    ch[prefix].addedUnknownCreated = unknown;

    for (const f of ch[prefix].fChanged) {
      const objLabel = objLabelByApi.get(f.obj) || null;
      const hit = lookupAudit(auditIndex, objLabel, f.label, 'changed', fieldLabelCount);
      if (hit) {
        f.changedBy = hit.who; f.changedDate = hit.date; f.changedByApprox = false;
      } else {
        const lm = lastMod[f.obj + '.' + f.field];
        f.changedBy = lm ? lm.by : null; f.changedDate = lm ? lm.date : null; f.changedByApprox = true;
      }
    }

    for (const f of ch[prefix].fRemoved) {
      const objLabel = objLabelByApi.get(f.obj) || null;
      const hit = lookupAudit(auditIndex, objLabel, f.label, 'deleted', fieldLabelCount);
      f.removedBy = hit ? hit.who : null;
      f.removedDate = hit ? hit.date : null;
    }

    console.log(prefix + ': added ' + ch[prefix].fAdded.length +
      ' | created after ' + PREV + ': ' + inWindow +
      ' | existed before (newly visible to scan): ' + preexisting +
      ' | standard/no CustomField row: ' + unknown +
      ' | changed attributed: ' + ch[prefix].fChanged.filter(f => f.changedBy && !f.changedByApprox).length + '/' + ch[prefix].fChanged.length +
      ' | removed attributed: ' + ch[prefix].fRemoved.filter(f => f.removedBy).length + '/' + ch[prefix].fRemoved.length);
  }
  fs.writeFileSync(OUT + '/changes.json', JSON.stringify(ch, null, 1));
  console.log('updated ' + OUT + '/changes.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
