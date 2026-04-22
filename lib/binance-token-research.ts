type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type BinanceEnvelope<T> = {
  code?: string;
  success?: boolean;
  data?: T;
};

export type TokenLink = {
  label: string;
  url: string;
};

export type TokenInfoResult = {
  available: boolean;
  source: "query-token-info";
  query: string;
  name: string | null;
  symbol: string | null;
  chainId: string | null;
  chainName: string | null;
  contractAddress: string | null;
  logo: string | null;
  price: string | null;
  marketCap: string | null;
  liquidity: string | null;
  volume24h: string | null;
  holdersTop10Percent: string | null;
  links: TokenLink[];
  tags: string[];
};

export type TokenAuditResult = {
  available: boolean;
  source: "query-token-audit";
  riskConclusion: "Low Risk" | "Medium Risk" | "High Risk" | "No audit data";
  riskLevelEnum: string | null;
  riskLevel: number | null;
  buyTax: string | null;
  sellTax: string | null;
  contractVerified: boolean | null;
  flags: Array<{ category: string; title: string; riskType: string | null }>;
  message?: string;
};

export type TokenRankMatch = {
  rank: number;
  category: string;
  boardType: string;
  chainId: string | null;
  symbol: string | null;
  contractAddress: string | null;
  hype: string | null;
};

export type TokenRankResult = {
  ranked: boolean;
  source: "crypto-market-rank";
  matches: TokenRankMatch[];
};

const BASE = "https://web3.binance.com";
const BNB_STATIC = "https://bin.bnbstatic.com";
const TOKEN_CHAINS = ["56", "8453", "CT_501"];
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit || hit.expiresAt < Date.now()) {
    if (hit) cache.delete(key);
    return null;
  }
  return hit.value as T;
}

function setCached<T>(key: string, value: T): T {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

function clean(value: string | null | undefined) {
  return value?.trim() || "";
}

function fullImageUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${BNB_STATIC}${url.startsWith("/") ? "" : "/"}${url}`;
}

function chainName(chainId: string | null | undefined) {
  if (chainId === "56") return "BSC";
  if (chainId === "8453") return "Base";
  if (chainId === "CT_501") return "Solana";
  if (chainId === "1") return "Ethereum";
  return chainId || null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "Accept-Encoding": "identity",
        "User-Agent": "binance-web3/2.1 (Skill)",
        ...(init?.headers || {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Binance Web3 request failed: ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLinks(raw: unknown): TokenLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      const item = x as { label?: unknown; link?: unknown; url?: unknown };
      const url = typeof item.link === "string" ? item.link : typeof item.url === "string" ? item.url : "";
      const label = typeof item.label === "string" ? item.label : "link";
      return url ? { label, url } : null;
    })
    .filter((x): x is TokenLink => Boolean(x));
}

function normalizeTags(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const values = Object.values(raw as Record<string, unknown>);
  const tags: string[] = [];
  for (const group of values) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const tagName = (item as { tagName?: unknown }).tagName;
      if (typeof tagName === "string" && tagName.trim()) tags.push(tagName);
    }
  }
  return Array.from(new Set(tags));
}

function pickToken(tokens: unknown[], query: string) {
  const q = query.toLowerCase();
  return (
    tokens.find((x) => String((x as { symbol?: unknown }).symbol || "").toLowerCase() === q) ||
    tokens.find((x) => String((x as { name?: unknown }).name || "").toLowerCase() === q) ||
    tokens[0]
  );
}

export async function getTokenInfo(query: string, chainId?: string | null): Promise<TokenInfoResult> {
  const keyword = clean(query).replace(/^\$/, "");
  const chain = clean(chainId);
  const cacheKey = `token-info:${keyword.toLowerCase()}:${chain}`;
  const cached = getCached<TokenInfoResult>(cacheKey);
  if (cached) return cached;

  const empty: TokenInfoResult = {
    available: false,
    source: "query-token-info",
    query: keyword,
    name: null,
    symbol: keyword || null,
    chainId: chain || null,
    chainName: chainName(chain),
    contractAddress: null,
    logo: null,
    price: null,
    marketCap: null,
    liquidity: null,
    volume24h: null,
    holdersTop10Percent: null,
    links: [],
    tags: [],
  };

  if (!keyword) return setCached(cacheKey, empty);

  try {
    const params = new URLSearchParams({
      keyword,
      chainIds: chain || TOKEN_CHAINS.join(","),
      orderBy: "volume24h",
    });
    const envelope = await fetchJson<BinanceEnvelope<unknown[]>>(
      `${BASE}/bapi/defi/v5/public/wallet-direct/buw/wallet/market/token/search/ai?${params}`
    );
    const tokens = Array.isArray(envelope.data) ? envelope.data : [];
    const picked = pickToken(tokens, keyword) as Record<string, unknown> | undefined;
    if (!picked) return setCached(cacheKey, empty);

    return setCached(cacheKey, {
      available: true,
      source: "query-token-info",
      query: keyword,
      name: typeof picked.name === "string" ? picked.name : null,
      symbol: typeof picked.symbol === "string" ? picked.symbol : keyword,
      chainId: typeof picked.chainId === "string" ? picked.chainId : chain || null,
      chainName: chainName(typeof picked.chainId === "string" ? picked.chainId : chain),
      contractAddress: typeof picked.contractAddress === "string" ? picked.contractAddress : null,
      logo: fullImageUrl(picked.icon),
      price: typeof picked.price === "string" ? picked.price : null,
      marketCap: typeof picked.marketCap === "string" ? picked.marketCap : null,
      liquidity: typeof picked.liquidity === "string" ? picked.liquidity : null,
      volume24h: typeof picked.volume24h === "string" ? picked.volume24h : null,
      holdersTop10Percent: typeof picked.holdersTop10Percent === "string" ? picked.holdersTop10Percent : null,
      links: normalizeLinks(picked.links),
      tags: normalizeTags(picked.tagsInfo),
    });
  } catch {
    return setCached(cacheKey, empty);
  }
}

function auditConclusion(level: string | null, numeric: number | null): TokenAuditResult["riskConclusion"] {
  if (level === "HIGH" || (numeric != null && numeric >= 4)) return "High Risk";
  if (level === "MEDIUM" || (numeric != null && numeric >= 2)) return "Medium Risk";
  if (level === "LOW" || (numeric != null && numeric <= 1)) return "Low Risk";
  return "No audit data";
}

export async function getTokenAudit(input: {
  symbol?: string | null;
  chainId?: string | null;
  contractAddress?: string | null;
}): Promise<TokenAuditResult> {
  let chainId = clean(input.chainId);
  let contractAddress = clean(input.contractAddress);
  const symbol = clean(input.symbol).replace(/^\$/, "");
  const cacheKey = `token-audit:${symbol.toLowerCase()}:${chainId}:${contractAddress.toLowerCase()}`;
  const cached = getCached<TokenAuditResult>(cacheKey);
  if (cached) return cached;

  const empty: TokenAuditResult = {
    available: false,
    source: "query-token-audit",
    riskConclusion: "No audit data",
    riskLevelEnum: null,
    riskLevel: null,
    buyTax: null,
    sellTax: null,
    contractVerified: null,
    flags: [],
    message: "No audit data available",
  };

  if ((!chainId || !contractAddress) && symbol) {
    const info = await getTokenInfo(symbol, chainId || null);
    chainId = info.chainId || "";
    contractAddress = info.contractAddress || "";
  }

  if (!chainId || !contractAddress) return setCached(cacheKey, empty);

  try {
    const envelope = await fetchJson<BinanceEnvelope<Record<string, unknown>>>(
      `${BASE}/bapi/defi/v1/public/wallet-direct/security/token/audit`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          source: "agent",
          "User-Agent": "binance-web3/1.4 (Skill)",
        },
        body: JSON.stringify({
          binanceChainId: chainId,
          contractAddress,
          requestId: crypto.randomUUID(),
        }),
      }
    );
    const data = envelope.data || {};
    if (data.hasResult !== true || data.isSupported !== true) return setCached(cacheKey, empty);

    const riskLevelEnum = typeof data.riskLevelEnum === "string" ? data.riskLevelEnum : null;
    const riskLevel = typeof data.riskLevel === "number" ? data.riskLevel : null;
    const extraInfo = (data.extraInfo || {}) as Record<string, unknown>;
    const flags: TokenAuditResult["flags"] = [];
    const riskItems = Array.isArray(data.riskItems) ? data.riskItems : [];
    for (const item of riskItems) {
      const category = String((item as { name?: unknown }).name || (item as { id?: unknown }).id || "Risk");
      const details = Array.isArray((item as { details?: unknown }).details) ? (item as { details: unknown[] }).details : [];
      for (const detail of details) {
        const d = detail as { isHit?: unknown; title?: unknown; riskType?: unknown };
        if (d.isHit === true) {
          flags.push({
            category,
            title: String(d.title || "Risk detected"),
            riskType: typeof d.riskType === "string" ? d.riskType : null,
          });
        }
      }
    }

    return setCached(cacheKey, {
      available: true,
      source: "query-token-audit",
      riskConclusion: auditConclusion(riskLevelEnum, riskLevel),
      riskLevelEnum,
      riskLevel,
      buyTax: typeof extraInfo.buyTax === "string" ? extraInfo.buyTax : null,
      sellTax: typeof extraInfo.sellTax === "string" ? extraInfo.sellTax : null,
      contractVerified: typeof extraInfo.isVerified === "boolean" ? extraInfo.isVerified : null,
      flags,
    });
  } catch {
    return setCached(cacheKey, empty);
  }
}

const rankTypes = [
  { rankType: 10, label: "Trending" },
  { rankType: 11, label: "Top Search" },
  { rankType: 20, label: "Alpha" },
];

function tokenMatches(token: Record<string, unknown>, symbol: string, contractAddress: string) {
  const tokenSymbol = String(token.symbol || "").toLowerCase();
  const tokenContract = String(token.contractAddress || "").toLowerCase();
  return (
    Boolean(symbol && tokenSymbol === symbol.toLowerCase()) ||
    Boolean(contractAddress && tokenContract === contractAddress.toLowerCase())
  );
}

export async function getTokenRank(input: {
  symbol?: string | null;
  chainId?: string | null;
  contractAddress?: string | null;
}): Promise<TokenRankResult> {
  let symbol = clean(input.symbol).replace(/^\$/, "");
  let chainId = clean(input.chainId);
  let contractAddress = clean(input.contractAddress);
  const cacheKey = `token-rank:${symbol.toLowerCase()}:${chainId}:${contractAddress.toLowerCase()}`;
  const cached = getCached<TokenRankResult>(cacheKey);
  if (cached) return cached;

  if ((!chainId || !contractAddress) && symbol) {
    const info = await getTokenInfo(symbol, chainId || null);
    chainId = info.chainId || "";
    contractAddress = info.contractAddress || "";
    symbol = info.symbol || symbol;
  }

  if (!symbol && !contractAddress) {
    return setCached(cacheKey, { ranked: false, source: "crypto-market-rank", matches: [] });
  }

  const chains = chainId ? [chainId] : TOKEN_CHAINS;
  const matches: TokenRankMatch[] = [];

  try {
    for (const chain of chains) {
      for (const rankType of rankTypes) {
        const envelope = await fetchJson<BinanceEnvelope<{ tokens?: unknown[] }>>(
          `${BASE}/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/unified/rank/list/ai`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              rankType: rankType.rankType,
              chainId: chain,
              period: 50,
              page: 1,
              size: 100,
            }),
          }
        );
        const tokens = Array.isArray(envelope.data?.tokens) ? envelope.data.tokens : [];
        const idx = tokens.findIndex((x) => tokenMatches(x as Record<string, unknown>, symbol, contractAddress));
        if (idx >= 0) {
          const token = tokens[idx] as Record<string, unknown>;
          matches.push({
            rank: idx + 1,
            category: rankType.label,
            boardType: "Unified Token Rank",
            chainId: typeof token.chainId === "string" ? token.chainId : chain,
            symbol: typeof token.symbol === "string" ? token.symbol : symbol || null,
            contractAddress: typeof token.contractAddress === "string" ? token.contractAddress : contractAddress || null,
            hype: typeof token.volume24h === "string" ? `24h volume ${token.volume24h}` : null,
          });
        }
      }
    }
    return setCached(cacheKey, { ranked: matches.length > 0, source: "crypto-market-rank", matches });
  } catch {
    return setCached(cacheKey, { ranked: false, source: "crypto-market-rank", matches: [] });
  }
}
