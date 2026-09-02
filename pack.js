// Pack both orgs' dictionary data into a compact tuple payload.
const fs = require('fs');
const OUT = __dirname.split(String.fromCharCode(92)).join('/');

// Refuse to stamp a fresh "generated" date onto stale inputs: if a scan failed,
// the old *_data.json would otherwise be republished as if it were current.
const MAX_AGE_H = Number(process.env.DICT_MAX_AGE_H || 12);
for (const f of ['sbu_data.json', 'xbu_data.json']) {
  const p = `${OUT}/${f}`;
  if (!fs.existsSync(p)) { console.error(`FATAL missing ${f} — scan/build step did not run`); process.exit(1); }
  const ageH = (Date.now() - fs.statSync(p).mtimeMs) / 3.6e6;
  if (ageH > MAX_AGE_H) {
    console.error(`FATAL ${f} is ${ageH.toFixed(1)}h old (limit ${MAX_AGE_H}h) — refusing to pack stale data`);
    process.exit(1);
  }
}

const sbu = JSON.parse(fs.readFileSync(`${OUT}/sbu_data.json`, 'utf8'));
const xbu = JSON.parse(fs.readFileSync(`${OUT}/xbu_data.json`, 'utf8'));

// shared pools; index 0 is the empty array
const refPool = [[]], pickPool = [[]];
const refIdx = new Map([['[]', 0]]), pickIdx = new Map([['[]', 0]]);
function poolPut(arr, pool, idx) {
  if (!arr || !arr.length) return 0;
  const k = JSON.stringify(arr);
  let i = idx.get(k);
  if (i === undefined) { i = pool.length; pool.push(arr); idx.set(k, i); }
  return i;
}

function packOrg(data) {
  return data.map(o => {
    const fields = o.fields.map(f => {
      const flags = (f.req ? 1 : 0) | (f.uniq ? 2 : 0) | (f.extId ? 4 : 0);
      const t = [f.name, f.label, f.type, f.len, flags, f.formula || '', f.desc || '', f.help || '',
                 poolPut(f.ref, refPool, refIdx), poolPut(f.pick, pickPool, pickIdx), f.gvs || ''];
      let n = t.length;
      while (n > 5 && !t[n - 1]) n--;   // drop trailing empties, keep the first 5
      return t.slice(0, n);
    });
    return [o.api, o.label, o.custom ? 1 : 0, fields];
  });
}

// stamp the run date so the header reflects when the org was actually scanned
const GEN = process.argv[2] || new Date().toISOString().slice(0, 10);

const orgs = [
  { id: 'sbu', name: 'SBU Production', sub: 'POS Nation · Quilt Software', gen: GEN,
    host: 'quiltsoftware', objs: packOrg(sbu) },
  { id: 'xbu', name: 'XBU Production', sub: 'Rain POS · rainpos.my.salesforce.com', gen: GEN,
    host: 'rainpos', objs: packOrg(xbu) },
];

const payload = { pools: { ref: refPool, pick: pickPool }, orgs };
const json = JSON.stringify(payload);
fs.writeFileSync(`${OUT}/packed.json`, json);

const rawSbu = fs.statSync(`${OUT}/sbu_data.json`).size;
const rawXbu = fs.statSync(`${OUT}/xbu_data.json`).size;
console.log('raw SBU        ', (rawSbu / 1e6).toFixed(2), 'MB');
console.log('raw XBU        ', (rawXbu / 1e6).toFixed(2), 'MB');
console.log('raw combined   ', ((rawSbu + rawXbu) / 1e6).toFixed(2), 'MB');
console.log('packed         ', (json.length / 1e6).toFixed(2), 'MB',
            `(${Math.round(100 - json.length / (rawSbu + rawXbu) * 100)}% smaller)`);
console.log('ref pool', refPool.length, '| pick pool', pickPool.length);
for (const o of orgs) {
  const nf = o.objs.reduce((a, x) => a + x[3].length, 0);
  console.log(`  ${o.id}: ${o.objs.length} objects, ${nf} fields`);
}
