'use strict';

// Read-only deployment check, also usable by the previous running image.
// Never call application services, providers, migrations or recovery jobs.
const Database = require('/app/backend-node/node_modules/better-sqlite3');
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
try {
  const required = ['async_tasks', 'image_generations', 'video_generations'];
  // Omni jobs are request snapshots; their lifecycle is in video_generations.
  const optional = ['video_upscale_jobs', 'video_interpolation_jobs', 'las_media_jobs', 'viral_edit_jobs', 'standalone_video_upscale_jobs'];
  const active = ['pending', 'queued', 'running', 'processing', 'submitting', 'uploading', 'downloading', 'persisting', 'finalizing', 'upscale_pending', 'upscaling', 'interpolation_pending', 'interpolating', 'awaiting_source', 'waiting_asset'];
  const counts = {};
  db.transaction(() => {
    for (const table of [...required, ...optional]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        if (required.includes(table)) throw new Error(`Required table missing: ${table}`);
        continue;
      }
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      if (!columns.has('status')) throw new Error(`Status column missing: ${table}`);
      // Include deleted rows conservatively: a deleted UI row can still run upstream.
      const dormant = ['video_upscale_jobs','video_interpolation_jobs'].includes(table)
        ? ` AND NOT (status='awaiting_source' AND COALESCE(provider_task_id,'')='' AND EXISTS (
            SELECT 1 FROM video_generations v WHERE v.id=${table}.video_generation_id
            AND v.status IN ('retryable','invalid','failed','cancelled') AND COALESCE(v.source_local_path,'')=''))`
        : '';
      counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status IN (${active.map(() => '?').join(',')})${dormant}`).get(...active).n;
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='relay_model_jobs'").get()) {
      counts.relay_model_jobs = db.prepare("SELECT COUNT(*) AS n FROM relay_model_jobs WHERE state IN ('queued','submitting','running','archiving')").get().n;
    }
  })();
  console.log(JSON.stringify({ active: counts }));
  process.exitCode = Object.values(counts).some(n => n > 0) ? 75 : 0;
} finally { db.close(); }
