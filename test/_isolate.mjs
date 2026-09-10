// Tests that exercise the REAL key-value store must not inherit the last run's data. The file backend reads
// DATA_DIR once, at import time, so this has to be set before store/kv.mjs is evaluated — import it first.
// Without it a set-valued assertion ("a reload does not add depth") passes on a clean checkout and fails on
// every rerun, which is exactly the kind of test that only goes red once it is inconvenient.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "block0-test-"));
