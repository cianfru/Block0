// Node entry for the smart-money radar: loads the committed wallet list; the feed itself is public/radar-feed.js
// (the same module the browser page runs).
import { readFileSync } from "node:fs";
import { walletsFrom } from "./public/radar-feed.js";
export { makeFeed, marketFor, walletsFrom, NATIVE } from "./public/radar-feed.js";

export const loadWallets = (path = new URL("./public/smart-wallets.json", import.meta.url)) => walletsFrom(JSON.parse(readFileSync(path, "utf8")));
