// The Setup field types a describe's `type` alone can't tell apart: an Auto Number is a
// string, a Roll-Up Summary a number/date/currency, a Master-Detail a reference, a Rich
// Text Area a textarea. Returns '' for everything `type` already identifies.
// Shared by scan_org2.js and the one-off backfill of an existing snapshot.
module.exports = function kindOf(f) {
  if (f.autoNumber) return 'autonumber';
  // a roll-up is calculated but has no formula; restricted to custom fields so a
  // standard field that Salesforce derives internally is not mislabelled
  if (f.custom && f.calculated && !f.calculatedFormula) return 'rollup';
  if (f.type === 'reference') {
    if (f.relationshipOrder != null) return 'masterdetail';
    if (f.extraTypeInfo === 'externallookup') return 'externallookup';
    if (f.extraTypeInfo === 'indirectlookup') return 'indirectlookup';
  }
  if (f.extraTypeInfo === 'richtextarea') return 'richtext';
  return '';
};
