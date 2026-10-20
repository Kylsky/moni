// Business receipts survive a failed model response or transcript write.
export const runDraftReceipt =
  "dataset_id=? AND json_extract(result_json,'$.threadId')=? AND json_extract(result_json,'$.runId')=? AND json_type(result_json,'$.draftId')='text'";

export async function readRunDraftIds(
  db: D1Database,
  datasetId: string,
  threadId: string,
  runId: string
) {
  const rows = await db
    .prepare(
      `SELECT json_extract(result_json,'$.draftId') AS id FROM operation_receipts WHERE ${runDraftReceipt} ORDER BY rowid DESC`
    )
    .bind(datasetId, threadId, runId)
    .all<{ id: string }>();
  return [...new Set(rows.results.map(({ id }) => id))];
}
