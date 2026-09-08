// Run on the single collector host (same KV/DATA_DIR). Redirect stdout to a private JSON file.
import { getJSONStrict } from "../store/kv.mjs";
import { EXPERIMENT_KEY, recordKey } from "../experiment.mjs";
const index = await getJSONStrict(EXPERIMENT_KEY);
if (!index) throw new Error("No forward experiment data");
const records = [], addresses = new Set(Object.keys(index.registry));
// Retired discoveries remain part of the research export, even though they no longer take registry slots.
for (let i = 0; i < 256; i++) {
  const shard = await getJSONStrict(`experiment:v1:archive:${i.toString(16).padStart(2,"0")}`);
  for (const address of Object.keys(shard || {})) addresses.add(address);
}
for (const address of addresses) {
  const record = await getJSONStrict(recordKey(address)); if (record) records.push(record);
}
console.log(JSON.stringify({ schema: 1, exportedAt: Date.now(), coverage: index.coverage, records }));
