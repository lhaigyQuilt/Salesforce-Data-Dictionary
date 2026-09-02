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

`refresh_dict.cmd` runs the whole chain and commits. It does **not** push — push by hand:

```
git push
```

It reads the previous run's date out of `changes.json` before overwriting it, copies the
old snapshot to `.prev/`, rescans both orgs, diffs, rebuilds and validates. Any step
failing aborts the run and writes to `refresh.log`.

To run it by hand: `refresh_dict.cmd`

### Scheduled run

A Windows Task Scheduler job ("SF Data Dictionary Refresh") fires this at 18:00 local on
the last day of each month. If the task still points at the old `C:\tmp\acctscan`
location it must be repointed at this directory, otherwise it will regenerate the
dictionary with the superseded object rule and overwrite the snapshot here.

## Two things that will bite you

**A describe only returns fields the running user can read.** Fields hidden by
field-level security are silently absent — no error. That makes an FLS grant look
exactly like a newly created field. This actually happened: the 2026-08-28 run showed
103 and 101 "added" fields, but only 2 and 5 were genuinely new; the rest, mostly on
`Project__c`, had existed since 2026-08-19/20 and had simply become visible.
`enrich_changes.js` exists to catch this — it joins every added field against
`CustomField.CreatedDate` and labels it `created` or `pre-existing`. An object reporting
~13 fields is the tell: that's system fields only.

**The explorer in `build_dict_html.js` is byte-identical to the originally published
page**, and `validate_merged.js` enforces that on every build. `build_dict_html3.js`
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
