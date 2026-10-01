#!/usr/bin/env node
// The static site (Vercel, no Node server) can't call /api/validation, so this writes the exact same payload to
// public/data/validation.json; public/vercel.json rewrites /api/validation to it. Re-run after the study changes.
//   node tools/export-static.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { composeValidation } from "../validation-view.mjs";

const v = JSON.parse(readFileSync("study/validation.json", "utf8"));
let c = null; try { c = JSON.parse(readFileSync("study/cohort.json", "utf8")); } catch { /* optional */ }
mkdirSync("public/data", { recursive: true });
writeFileSync("public/data/validation.json", JSON.stringify(composeValidation(v, c)));
console.log("public/data/validation.json written");
