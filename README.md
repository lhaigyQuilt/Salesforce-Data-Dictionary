# Salesforce Data Dictionary — SBU & XBU Production

Field-level schema reference for both production orgs, regenerated monthly, with a
"changes since last run" page on the front.

- **SBU Production** — `posnation.my.salesforce.com` (POS Nation · Quilt Software), CLI alias `production`
- **XBU Production** — `rainpos.my.salesforce.com` (Rain POS), CLI alias `xbu`

The built page is [`salesforce-data-dictionary.html`](salesforce-data-dictionary.html) —
one self-contained file, no build step needed to view it. Open it directly, or read the
published copy at https://claude.ai/code/artifact/64063eea-24ee-4ce2-8f56-13bd40b19cc9

## What's in the repo

| File | |
|---|---|
| `salesforce-data-dictionary.html` | the built page (~0.8 MB) |
| `sbu_data.json`, `xbu_data.json` | **the snapshot** — this is the diff baseline for next month |
| `changes.json` | this run's diff, including each run's date |
| `scan_org2.js` | queries `EntityDefinition`, describes in batches of 25, streams to the data file |
| `field_kind.js` | tells apart the Setup types a describe `type` hides (Auto Number, Roll-Up Summary, Master-Detail, Rich Text, External/Indirect Lookup) |
| `diff_snapshot.js` | diffs against the previous snapshot, separating real change from rule churn |
| `enrich_changes.js` | tags each added field with its real `CustomField.CreatedDate` |
| `pack.js` | packs both orgs into `packed.json` |
| `build_dict_html3.js` | builds the page: changes view + the explorer |
| `build_dict_html.js` | **provenance** — the original explorer. Do not edit casually (see below) |
| `validate_merged.js` | pre-publish checks |

Committing the two `*_data.json` files is the point of the repo: each month's commit
*is* the baseline the next diff runs against, and the history gives you every prior
snapshot for free.

## Refreshing

`refresh_dict.cmd` runs the whole chain, commits and pushes (Railway and Vercel redeploy
from `main`). It starts with `git pull --ff-only` so edits made on GitHub since the last
run don't make the push bounce. If the push still fails, the commit stays local, the log
ends `COMMITTED BUT PUSH FAILED` and the task exits 2 — then push by hand:

```
git push
```

It reads the previous run's date out of `changes.json` before overwriting it, copies the
old snapshot to `.prev/`, rescans both orgs, diffs, rebuilds and validates. Any step
failing aborts the run and writes to `refresh.log`.

To run it by hand: `refresh_dict.cmd`

### Scheduled run

A Windows Task Scheduler job ("SF Data Dictionary Refresh") fires this at 07:00 local on
the 1st of each month (it runs late if the PC was off). It runs as the signed-in user, so
the sf CLI logins for `production`/`xbu` and the Git Credential Manager login must both
still be valid.

## Two things that will bite you

**A describe only returns fields the running user can read.** Fields hidden by
field-level security are silently absent — no error. That makes an FLS grant look
exactly like a newly created field. This actually happened: the 2026-08-28 run showed
103 and 101 "added" fields, but only 2 and 5 were genuinely new; the rest, mostly on
`Project__c`, had existed since 2026-08-19/20 and had simply become visible.
`enrich_changes.js` exists to catch this — it joins every added field against
`CustomField.CreatedDate` and labels it `created` or `pre-existing`. An object reporting
~13 fields is the tell: that's system fields only.

**The explorer in `build_dict_html.js` is the reference copy of the explorer** (originally
byte-identical to the first published page; deliberately updated 2026-10-27 for the
per-type Show filter and Custom/Standard/Managed chips), and `validate_merged.js` enforces
that the built page matches it on every build. `build_dict_html3.js`
holds it in a `type="text/plain"` block and executes it verbatim once the gzipped
payload is inflated — that indirection exists purely so the search behaviour could stay
untouched while the page got small enough to publish. If you change the explorer, that
check fails by design; update the reference deliberately, not to make the check pass.

## Object selection

Objects come from, per org:

```sql
SELECT QualifiedApiName, Label FROM EntityDefinition
WHERE IsCustomizable = true AND IsQueryable = true
ORDER BY QualifiedApiName
```

minus anything ending in `Share`, `History`, `Feed`, `ChangeEvent`, `Tag`, `__e`, `Rule`
or `RuleShare`. That yields 546 objects per org.

This replaced an older rule (23 hand-picked standard objects plus any custom suffix,
platform events included). Objects that appear or disappear purely because the rule
changed are reported separately and are **not** counted as schema changes —
`diff_snapshot.js` carries both rules so it can tell the two apart.

## Requirements

- Node (uses built-in `fetch` and `zlib`; no dependencies)
- Salesforce CLI authenticated to both orgs — the scripts shell out to
  `C:/Program Files/sf/client/bin/run.js` for an access token, then call the REST and
  Tooling APIs directly. **That CLI path is hardcoded**; change it in `scan_org2.js` and
  `enrich_changes.js` if the CLI moves.
- Access is strictly read-only: describes and Tooling `SELECT`s, no writes.
- Viewing the page needs a browser with `DecompressionStream` (current Chrome, Edge,
  Firefox, Safari).

## Hosting

`server.js` serves the page so it can run on Railway (or any PaaS that sets `PORT`).
Node built-ins only — no dependencies. Locally:

```
npm start          # http://localhost:3000
```

Routes are an explicit allowlist: `/` and `/index.html` serve the dictionary,
`/changes.json`, `/sbu_data.json` and `/xbu_data.json` serve the data, `/healthz`
returns `ok`. Nothing is resolved from the request path, so traversal returns 404.

**There is deliberately no `build` script.** Railway's builder runs one automatically
if present, and `pack.js` refuses to run on data more than 12 hours old — so any deploy
made more than half a day after a refresh would fail the build for no reason. The page
is committed already and needs no build step. Rebuild locally instead:

```
node pack.js && node build_dict_html3.js
```

### Deploying the right commit

Railway's **Redeploy** on an old deployment row rebuilds *that row's* commit, not the
latest. To deploy current `main`, push a commit or use the service's deploy action —
otherwise it will keep rebuilding whichever commit that row pinned.
