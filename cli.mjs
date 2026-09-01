// Quick CLI to run a scan without the server — `node cli.mjs 0x<token> [decimals] [windowBlocks]`.
import { scan } from "./engine.mjs";
const [addr, dec, win] = process.argv.slice(2);
if (!addr) { console.error("usage: node cli.mjs 0x<token> [decimals] [windowBlocks]"); process.exit(1); }
const r = await scan(addr, { decimals: Number(dec || 18), windowBlocks: Number(win || 1500) });
const k = (x) => Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(2) + "M" : Math.abs(x) >= 1e3 ? (x / 1e3).toFixed(1) + "k" : (+x).toFixed(0);
const s = r.scores;
console.log(`\n${r.address}  [${r.mode}]  pulled ${s.transfers} transfers in ${r.pullMs}ms  ·  pool ${r.pool}`);
console.log(`pressure ${s.pressure.toUpperCase()}  ·  buys ${s.buys}(${k(s.buyVol)}) sells ${s.sells}(${k(s.sellVol)})  ·  net ${k(s.netVol)}`);
console.log(`holders ${s.holders} · top-10 hold ${s.top10Share}% · snipers ${s.snipers} (hold ${s.sniperHeldShare}%) · bundles ${s.bundles} · ${s.spanHours}h`);
console.log(`\ntop sellers:`); for (const w of r.sellers) console.log(`  ${w.a} ${k(w.net)}${w.sniper ? "  ⚡sniper" : ""}`);
console.log(`top buyers:`); for (const w of r.buyers) console.log(`  ${w.a} +${k(w.net)}${w.sniper ? "  ⚡sniper" : ""}`);
