'use strict';

// Read existing evidence only: never resubmit a task or change historical rows.
function requestId(db, row) {
  const explicit = String(row?.provider_request_id || row?.request_id || '').trim();
  if (explicit) return explicit;
  const embedded = String(row?.error_msg || '').match(/(?:request[\s_-]*id|x-request-id|响应\s*id)\s*[:=：]\s*([a-z0-9][a-z0-9._:-]{5,})/i);
  if (embedded) return embedded[1].replace(/[.,;，。；]+$/, '');
  if (!db || !row?.billing_authorization_id || !row?.owner_user_id) return null;
  try {
    const evidence = db.prepare(`SELECT DISTINCT TRIM(provider_request_id) AS request_id FROM cost_calls
      WHERE authorization_id=? AND user_id=? AND service_type='video'
        AND (? IS NULL OR provider_task_id=?)
        AND provider_request_id IS NOT NULL AND TRIM(provider_request_id)<>''`)
      .all(row.billing_authorization_id, row.owner_user_id, row.provider_task_id || null, row.provider_task_id || null);
    // Conflicting attempts are not sufficient evidence for a single response ID.
    return evidence.length === 1 ? evidence[0].request_id : null;
  } catch (error) {
    if (/no such (?:table|column)/i.test(error.message)) return null;
    throw error;
  }
}

module.exports = { requestId };
