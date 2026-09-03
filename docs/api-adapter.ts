// ┌─ REFERENCE ADAPTER (for the Lovable front end — drop into the design app as src/lib/api.ts) ──────────┐
// │ This is a copy kept with the backend so the field mapping stays in sync with the API. It imports the  │
// │ design's own `Token` type from "@/lib/block0"; that path resolves inside the design app, not here.    │
// └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
// LIVE DATA LAYER — swaps the mock arrays in block0.ts for real fetches against the Block0 backend API.
//
// The design ships with static mocks (TOKENS/BUYERS/SELLERS/…) so the UI can render in isolation. This module
// keeps every type + helper + the risk scale from block0.ts and only replaces the DATA: it fetches our public,
// read-only /api/* endpoints and maps each response onto the design's Token / wallet shapes so no component has
// to change. Routes swap `import { TOKENS }` for the `useBoard()/useToken()/useWallet()` hooks below.
//
// Endpoint base: set VITE_BLOCK0_API to the backend origin (e.g. https://block0.up.railway.app). If unset we call
// same-origin "/api/…", which works when the site is reverse-proxied onto the backend. The backend sends
// permissive CORS, so a cross-origin absolute base works too.
import { useQuery } from "@tanstack/react-query";
import type { Token } from "@/lib/block0";

const RAW_BASE = (import.meta.env.VITE_BLOCK0_API ?? "").replace(/\/$/, "");
const API = RAW_BASE ? `${RAW_BASE}/api` : "/api";

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as T;
}

// ── the backend verdict shape (only the fields we read) ───────────────────────────────────────────────
type RawVerdict = {
  sym?: string; name?: string | null; address: string;
  mcapUsd?: number; risk?: number; label?: string; momentum?: number; ageH?: number; progress?: number;
  parts?: { snipers: number; bundles: number; concentration: number; dumping: number; deployer: number };
  flags?: {
    holders?: number; wallets?: number; top10Pct?: number; snipers?: number; bundles?: number;
    insiderSellersNow?: number;
  };
  blueprint?: number; blueprintLabel?: string;
  corridor?: { traj?: number; status?: "on-track" | "behind" | "failing" };
  path?: { precedent?: number; ratio?: number };
  venue?: string; logo?: string | null;
};

// backend label is UPPERCASE ("LOOKS CLEANER"); the design wants sentence case.
const LABELS: Record<string, string> = {
  "LOOKS CLEANER": "Looks cleaner", MIXED: "Mixed", CAUTION: "Caution", "HIGH RISK": "High risk",
};
// backend corridor status "behind" is the design's "drifting".
const CORRIDOR_STATUS: Record<string, Token["corridor"]["status"]> = {
  "on-track": "on-track", behind: "drifting", failing: "failing",
};

function mapToken(v: RawVerdict, section: Token["section"]): Token {
  const f = v.flags ?? {};
  const risk = Math.round(v.risk ?? 0);
  const rawLabel = (v.label ?? "").toUpperCase();
  const venue: Token["venue"] = v.venue === "uniswap-v4" || section === "dex" ? "uniswap-v4" : "pons";
  const insiderSellersNow = f.insiderSellersNow ?? 0;
  return {
    sym: v.sym ?? "?",
    name: v.name ?? v.sym ?? "Unknown",
    address: v.address,
    mcapUsd: Math.round(v.mcapUsd ?? 0),
    risk,
    label: LABELS[rawLabel] ?? (risk < 25 ? "Looks cleaner" : risk < 45 ? "Mixed" : risk <= 65 ? "Caution" : "High risk"),
    ageH: v.ageH ?? 0,
    parts: v.parts ?? { snipers: 0, bundles: 0, concentration: 0, dumping: 0, deployer: 0 },
    flags: {
      holders: f.holders ?? 0,
      wallets: f.wallets ?? f.holders ?? 0,
      top10Pct: Math.round(f.top10Pct ?? 0),
      snipers: f.snipers ?? 0,
      bundles: f.bundles ?? 0,
      insiderSellersNow,
    },
    blueprint: Math.round(v.blueprint ?? 0),
    blueprintLabel: v.blueprintLabel ?? "—",
    corridor: {
      traj: v.corridor?.traj ?? 0,
      status: CORRIDOR_STATUS[v.corridor?.status ?? ""] ?? "drifting",
    },
    path: { precedent: v.path?.precedent ?? 0, ratio: v.path?.ratio ?? 0 },
    ...(v.progress != null ? { progress: v.progress } : {}),
    venue,
    section,
    momentum: v.momentum ?? 0,
    ...(section === "dex" && venue === "uniswap-v4"
      ? { alert: { tone: "warn" as const, text: "direct DEX listing — no launchpad guardrails" } }
      : insiderSellersNow > 0
        ? { alert: { tone: "bad" as const, text: `${insiderSellersNow} insider${insiderSellersNow > 1 ? "s" : ""} selling now` } }
        : risk < 25 && (f.bundles ?? 0) === 0 && (f.snipers ?? 0) === 0
          ? { alert: { tone: "good" as const, text: "no snipers · no bundles" } }
          : {}),
  };
}

// ── board ─────────────────────────────────────────────────────────────────────────────────────────────
type RawBoard = {
  updated: number | null; scanning: boolean;
  cooking: RawVerdict[]; graduated: RawVerdict[]; dex: RawVerdict[];
  stats?: unknown;
};

export type Board = { updated: number | null; scanning: boolean; tokens: Token[] };

export async function fetchBoard(): Promise<Board> {
  const b = await getJSON<RawBoard>("/board");
  const tokens = [
    ...(b.cooking ?? []).map((v) => mapToken(v, "cooking")),
    ...(b.graduated ?? []).map((v) => mapToken(v, "graduated")),
    ...(b.dex ?? []).map((v) => mapToken(v, "dex")),
  ];
  return { updated: b.updated, scanning: b.scanning, tokens };
}

export function useBoard() {
  return useQuery({
    queryKey: ["board"],
    queryFn: fetchBoard,
    refetchInterval: 30_000, // the board self-refreshes server-side; keep the UI within ~30s of it
    staleTime: 15_000,
  });
}

// ── single token dossier ────────────────────────────────────────────────────────────────────────────
// /api/token returns a verdict enriched with `whales` (bags), `bundles`, and (where computed) `deployer.others`.
export type WalletRow = { a: string; bal: number; net: number; sniper: boolean };
export type TokenDossier = {
  token: Token;
  buyers: WalletRow[];
  sellers: WalletRow[];
  holders: WalletRow[];
  deployer?: { address: string; others?: { address: string; sym?: string; outcome?: string }[] };
};

type RawWalletRow = { a: string; bal: number; net: number; sniper: boolean; bought?: number; sold?: number };
type RawDeployer = {
  address: string; reputation?: string; launched?: number; graduated?: number;
  others?: { sym?: string; address: string; mcapUsd?: number; graduated?: boolean }[];
};
type RawToken = RawVerdict & {
  // the dossier pre-splits the holder table; whales[] is the fallback if an older backend is in front.
  buyers?: RawWalletRow[]; sellers?: RawWalletRow[]; topHolders?: RawWalletRow[]; whales?: RawWalletRow[];
  deployer?: RawDeployer | null; graduated?: boolean;
};

const row = (w: RawWalletRow): WalletRow => ({ a: w.a, bal: w.bal, net: w.net, sniper: !!w.sniper });

export async function fetchToken(address: string): Promise<TokenDossier> {
  const v = await getJSON<RawToken>(`/token?address=${address}`);
  const section: Token["section"] =
    v.venue === "uniswap-v4" ? "dex" : v.graduated ? "graduated" : "cooking";
  const whales = v.whales ?? [];
  const buyers = (v.buyers ?? whales.filter((w) => w.net > 0).sort((a, b) => b.net - a.net)).slice(0, 6).map(row);
  const sellers = (v.sellers ?? whales.filter((w) => w.net < 0).sort((a, b) => a.net - b.net)).slice(0, 6).map(row);
  const holders = (v.topHolders ?? whales.slice().sort((a, b) => b.bal - a.bal)).slice(0, 6).map(row);
  const deployer = v.deployer
    ? { address: v.deployer.address, others: (v.deployer.others ?? []).map((o) => ({ address: o.address, sym: o.sym, outcome: o.graduated ? "graduated" : "faded" })) }
    : undefined;
  return { token: mapToken(v, section), buyers, sellers, holders, ...(deployer ? { deployer } : {}) };
}

export function useToken(address: string | undefined) {
  return useQuery({
    queryKey: ["token", address],
    queryFn: () => fetchToken(address as string),
    enabled: !!address && /^0x[0-9a-fA-F]{40}$/.test(address),
    staleTime: 20_000,
  });
}

// ── wallet footprint ──────────────────────────────────────────────────────────────────────────────────
export type WalletTrade = {
  sym: string; bought: number; sold: number; net: number;
  nBuys: number; nSells: number; held: boolean; first: string; last: string;
};
export type WalletProfile = {
  address: string; tokensTraded: number; held: number; exited: number;
  style: string; styleLabel: string; trades: WalletTrade[];
};

type RawWallet = {
  address: string; tokensTraded: number; held: number; exited: number; style: string;
  tokens: { token: string; sym?: string | null; bought: number; sold: number; net: number;
    nBuys: number; nSells: number; first: number | null; last: number | null; held: boolean; exited: boolean }[];
};

function ago(ts: number | null): string {
  if (!ts) return "—";
  const h = (Date.now() / 1000 - ts) / 3600;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

const STYLE_LABEL: Record<string, string> = {
  "active-trader": "Flipper-leaning", holder: "Holder-leaning", mixed: "Mixed",
};

export async function fetchWallet(address: string): Promise<WalletProfile> {
  const w = await getJSON<RawWallet>(`/wallet?address=${address}`);
  return {
    address: w.address, tokensTraded: w.tokensTraded, held: w.held, exited: w.exited,
    style: w.style, styleLabel: STYLE_LABEL[w.style] ?? "Mixed",
    trades: (w.tokens ?? []).map((t) => ({
      sym: t.sym ?? t.token.slice(0, 6), bought: t.bought, sold: t.sold, net: t.net,
      nBuys: t.nBuys, nSells: t.nSells, held: t.held, first: ago(t.first), last: ago(t.last),
    })),
  };
}

export function useWallet(address: string | undefined) {
  return useQuery({
    queryKey: ["wallet", address],
    queryFn: () => fetchWallet(address as string),
    enabled: !!address && /^0x[0-9a-fA-F]{40}$/.test(address),
    staleTime: 60_000,
  });
}
