import { Pool } from "pg";
import { approvePendingReview } from "D:/git/primebrick/primebrick-dal-v3/src/migrations/status.ts";
const pool = new Pool({ connectionString: "postgres://primebrick:primebrick_dev@127.0.0.1:5432/primebrick" });
const jobs: Array<[string, string]> = [
  ["ai", "20261124112105_create_ai_sequences_ai_sequence_counters"],
  ["emailsender", "20261124112106_create_emailsender_sequences_emailsender_sequence_counters"],
  ["job", "20261124112108_create_job_sequences_job_sequence_counters"],
  ["webhook", "20261124112110_create_webhook_sequences_webhook_sequence_counters"],
  ["boilerplate", "20261124112111_create_boilerplate_sequences_boilerplate_sequence_counters"],
];
for (const [schema, name] of jobs) {
  const ok = await approvePendingReview(pool, schema, name, "devin", "drift remediation — user-reviewed default alignment");
  console.log(schema, name.slice(0, 40), "→", ok ? "approved" : "NOT FOUND");
}
await pool.end();
