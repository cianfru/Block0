// Run on the single collector host (same KV/DATA_DIR). Redirect stdout to a private JSON file.
import { getJSONStrict } from "../store/kv.mjs";
import { EXPERIMENT_KEY, recordKey } from "../experiment.mjs";
const index = await getJSONStrict(EXPERIMENT_KEY);
if (!index) throw new Error("No forward experiment data");
const records = [];
for (const address of Object.keys(index.registry)) {
  const record = await getJSONStrict(recordKey(address)); if (record) records.push(record);
}
console.log(JSON.stringify({ schema: 1, exportedAt: Date.now(), coverage: index.coverage, records }));
