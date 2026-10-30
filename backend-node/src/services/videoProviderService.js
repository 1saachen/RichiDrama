'use strict';

// Read-only correction for legacy rows that stored the UI's default provider.
// Never use today's mutable AI configuration to rewrite historical attribution.
function recordedProvider(db, row) {
  const stored = row?.provider || null;
  if (!row?.billing_authorization_id || !row?.owner_user_id) return stored;
  try {
    const evidence = db.prepare(`SELECT DISTINCT provider FROM cost_calls
      WHERE authorization_id=? AND user_id=? AND service_type='video'
      AND provider IS NOT NULL AND TRIM(provider)<>''`)
      .all(row.billing_authorization_id, row.owner_user_id);
    return evidence.length === 1 ? evidence[0].provider : stored;
  } catch (error) {
    if (/no such (?:table|column)/i.test(error.message)) return stored;
    throw error;
  }
}

module.exports = { recordedProvider };
