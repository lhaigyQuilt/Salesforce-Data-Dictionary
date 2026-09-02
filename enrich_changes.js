// Annotate each added field in changes.json with its CustomField CreatedDate, so
// the page can distinguish "created since the last run" from "existed already but
// only became visible to the scan" (e.g. field-level security granted later).
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

(async () => {
  const ch = JSON.parse(fs.readFileSync(OUT + '/changes.json', 'utf8'));
  for (const [alias, prefix] of [['production', 'sbu'], ['xbu', 'xbu']]) {
    const { I, H } = await tokenFor(alias);
    let p = '/services/data/' + API + '/tooling/query/?q=' + encodeURIComponent(
      'SELECT DeveloperName, NamespacePrefix, CreatedDate, EntityDefinition.QualifiedApiName FROM CustomField');
    const created = {};
    for (;;) {
      const r = await fetch(I + p, { headers: H });
      if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      for (const c of j.records || []) {
        const obj = c.EntityDefinition ? c.EntityDefinition.QualifiedApiName : null;
        if (!obj) continue;
        created[obj + '.' + (c.NamespacePrefix ? c.NamespacePrefix + '__' : '') + c.DeveloperName + '__c'] =
          c.CreatedDate.slice(0, 10);
      }
      if (j.done || !j.nextRecordsUrl) break;
      p = j.nextRecordsUrl;
    }
    let inWindow = 0, preexisting = 0, unknown = 0;
    for (const f of ch[prefix].fAdded) {
      const d = created[f.obj + '.' + f.field];
      f.created = d || null;
      if (!d) unknown++;
      else if (d > PREV) { f.newInWindow = true; inWindow++; }
      else { f.newInWindow = false; preexisting++; }
    }
    ch[prefix].addedCreatedInWindow = inWindow;
    ch[prefix].addedPreexisting = preexisting;
    ch[prefix].addedUnknownCreated = unknown;
    console.log(prefix + ': added ' + ch[prefix].fAdded.length +
      ' | created after ' + PREV + ': ' + inWindow +
      ' | existed before (newly visible to scan): ' + preexisting +
      ' | standard/no CustomField row: ' + unknown);
  }
  fs.writeFileSync(OUT + '/changes.json', JSON.stringify(ch, null, 1));
  console.log('updated ' + OUT + '/changes.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
