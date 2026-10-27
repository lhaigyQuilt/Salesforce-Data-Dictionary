// Step 4: diff new snapshot against the previous one, separating genuine schema
// change from churn caused by the step-2 object-selection rule changing.
const fs = require('fs');
const OUT = __dirname.split(String.fromCharCode(92)).join('/');
const BASE = process.argv[2];   // dir holding the previous sbu_data.json / xbu_data.json
const PREV_DATE = process.argv[3] || 'unknown';

// The object rule that produced the PREVIOUS snapshot (from scan_org.js).
const OLD_STD = ['Account','Asset','Campaign','CampaignMember','Case','Contact','Contract','EmailMessage',
  'Entitlement','Event','Lead','Opportunity','OpportunityLineItem','Order','OrderItem','Pricebook2',
  'PricebookEntry','Product2','Quote','QuoteLineItem','ServiceContract','Task','User'];
const OLD_SUFFIX = /(__c|__mdt|__e|__kav|__b)$/;
const OLD_EXCL = /__(History|Share|Feed|ChangeEvent)$/;
const oldEligible = a => (OLD_STD.includes(a) || OLD_SUFFIX.test(a)) && !OLD_EXCL.test(a);

// The object rule used for THIS snapshot (step 2 exclusions).
const NEW_EXCL = /(Share|History|Feed|ChangeEvent|Tag|Rule|RuleShare)$|__e$/;
const newEligible = a => !NEW_EXCL.test(a);

const CMP = ['type', 'req', 'pick'];   // step 4: type, required flag, picklist values
const pickKey = f => (f.pick || []).join('\u0001');

const report = {};

for (const prefix of ['sbu', 'xbu']) {
  const prev = JSON.parse(fs.readFileSync(BASE + '/' + prefix + '_data.json', 'utf8'));
  const cur = JSON.parse(fs.readFileSync(OUT + '/' + prefix + '_data.json', 'utf8'));
  const P = new Map(prev.map(o => [o.api, o]));
  const C = new Map(cur.map(o => [o.api, o]));

  const objAdded = [], objRemoved = [], churnAdded = [], churnRemoved = [];
  for (const api of C.keys()) {
    if (P.has(api)) continue;
    (oldEligible(api) ? objAdded : churnAdded).push(api);
  }
  for (const api of P.keys()) {
    if (C.has(api)) continue;
    (newEligible(api) ? objRemoved : churnRemoved).push(api);
  }

  // field-level: only objects present in BOTH snapshots
  const fAdded = [], fRemoved = [], fChanged = [];
  for (const [api, co] of C) {
    const po = P.get(api);
    if (!po) continue;
    const pf = new Map(po.fields.map(f => [f.name, f]));
    const cf = new Map(co.fields.map(f => [f.name, f]));
    // desc travels with the row: a deleted field's description exists only in the old snapshot
    for (const [n, f] of cf) if (!pf.has(n)) fAdded.push({ obj: api, field: n, label: f.label, type: f.type, desc: f.desc || '' });
    for (const [n, f] of pf) if (!cf.has(n)) fRemoved.push({ obj: api, field: n, label: f.label, type: f.type, desc: f.desc || '' });
    for (const [n, a] of pf) {
      const b = cf.get(n); if (!b) continue;
      const ch = [];
      if (a.type !== b.type) ch.push({ attr: 'type', from: a.type, to: b.type });
      if (!!a.req !== !!b.req) ch.push({ attr: 'required', from: !!a.req, to: !!b.req });
      if (pickKey(a) !== pickKey(b)) {
        const pa = new Set(a.pick || []), pb = new Set(b.pick || []);
        ch.push({ attr: 'picklist',
          added: [...pb].filter(v => !pa.has(v)),
          removed: [...pa].filter(v => !pb.has(v)),
          reordered: [...pb].filter(v => pa.has(v)).length === pa.size && pa.size === pb.size });
      }
      if (ch.length) fChanged.push({ obj: api, field: n, label: b.label, desc: b.desc || a.desc || '', changes: ch });
    }
  }

  report[prefix] = {
    prevObjects: P.size, curObjects: C.size,
    prevFields: prev.reduce((a, o) => a + o.fields.length, 0),
    curFields: cur.reduce((a, o) => a + o.fields.length, 0),
    objAdded, objRemoved, churnAdded, churnRemoved, fAdded, fRemoved, fChanged
  };
}

report.prevDate = PREV_DATE;
report.genDate = new Date().toISOString().slice(0, 10);
fs.writeFileSync(OUT + '/changes.json', JSON.stringify(report, null, 1));

for (const p of ['sbu', 'xbu']) {
  const r = report[p];
  console.log('\n== ' + p.toUpperCase());
  console.log('  objects ' + r.prevObjects + ' -> ' + r.curObjects + ' | fields ' + r.prevFields + ' -> ' + r.curFields);
  console.log('  REAL   objects added ' + r.objAdded.length + ', removed ' + r.objRemoved.length);
  if (r.objAdded.length) console.log('         + ' + r.objAdded.join(', '));
  if (r.objRemoved.length) console.log('         - ' + r.objRemoved.join(', '));
  console.log('  REAL   fields added ' + r.fAdded.length + ', removed ' + r.fRemoved.length + ', changed ' + r.fChanged.length);
  r.fAdded.slice(0, 15).forEach(f => console.log('         + ' + f.obj + '.' + f.field + ' (' + f.type + ')'));
  if (r.fAdded.length > 15) console.log('           ...and ' + (r.fAdded.length - 15) + ' more');
  r.fRemoved.slice(0, 15).forEach(f => console.log('         - ' + f.obj + '.' + f.field + ' (' + f.type + ')'));
  if (r.fRemoved.length > 15) console.log('           ...and ' + (r.fRemoved.length - 15) + ' more');
  r.fChanged.slice(0, 15).forEach(f => console.log('         ~ ' + f.obj + '.' + f.field + ' :: ' +
    f.changes.map(c => c.attr === 'picklist'
      ? 'picklist +' + c.added.length + '/-' + c.removed.length
      : c.attr + ' ' + c.from + '->' + c.to).join(', ')));
  if (r.fChanged.length > 15) console.log('           ...and ' + (r.fChanged.length - 15) + ' more');
  console.log('  CHURN  rule-only added ' + r.churnAdded.length + ', rule-only removed ' + r.churnRemoved.length + ' (not reported as schema change)');
}
console.log('\nwrote ' + OUT + '/changes.json');
