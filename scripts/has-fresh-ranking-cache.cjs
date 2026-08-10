const Database = require("better-sqlite3");

const minutes = Math.max(1, Number(process.argv[2] ?? 30) || 30);
const minimumCompleteBatch = Math.max(100, Number(process.argv[3] ?? 1000) || 1000);
const db = new Database("data/pollybot.sqlite", { readonly: true });
const row = db
  .prepare(`
    WITH newest_batch AS (
      SELECT scan_batch_id
      FROM latest_rankings
      WHERE scan_batch_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    )
    SELECT COUNT(*) AS batch_count, MAX(lr.created_at) AS last_created
    FROM latest_rankings lr
    JOIN newest_batch nb ON nb.scan_batch_id = lr.scan_batch_id
  `)
  .get();
db.close();

const last = row?.last_created ? Date.parse(row.last_created) : NaN;
// A killed scan may have a recent timestamp but only a handful of rows. Never let
// that partial batch suppress the next full scan or feed fast sweeps for 30 minutes.
const complete = Number(row?.batch_count ?? 0) >= minimumCompleteBatch;
const fresh = complete && Number.isFinite(last) && Date.now() - last <= minutes * 60 * 1000;
process.stdout.write(fresh ? "fresh" : "stale");
