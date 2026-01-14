// Verified Tokens Registry
// Static curated token list for fast lookup without network calls
// Sources: Data API /tokens/category/verified + monad-contracts.json
// Copyright (c) 2026 s0nderlabs

import { type Address } from "viem";
import type { TokenInfo } from "./tokens.js";

/**
 * Monad Verified Tokens (25 tokens)
 *
 * Source: Data API /tokens/category/verified
 *
 * Categories:
 * - Native/Wrapped: MON, WMON
 * - Stablecoins: USDC, USDT0, AUSD
 * - LST: aprMON, gMON, sMON, shMON
 * - Bridged: WETH, WBTC, wstETH, SOL
 * - Synthetic: suBTC, suETH
 * - Meme: CHOG, MCA, 143
 * - Other: UNIT, ANAGO, APR, earnAUSD
 */
export const VERIFIED_TOKENS: TokenInfo[] = [
  // === NATIVE & WRAPPED ===
  {
    address: "0x0000000000000000000000000000000000000000" as Address,
    symbol: "MON",
    name: "Monad",
    decimals: 18,
    kind: "native",
    categories: ["official", "verified", "native"],
  },
  {
    address: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" as Address,
    symbol: "WMON",
    name: "Wrapped MON",
    decimals: 18,
    kind: "wrappedNative",
    categories: ["official", "verified", "wrapped"],
  },

  // === STABLECOINS ===
  {
    address: "0x754704bc059f8c67012fed69bc8a327a5aafb603" as Address,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    kind: "erc20",
    categories: ["verified", "stable"],
  },
  {
    address: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d" as Address,
    symbol: "USDT0",
    name: "Tether USD (Stargate)",
    decimals: 6,
    kind: "erc20",
    categories: ["verified", "stable"],
  },
  {
    address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a" as Address,
    symbol: "AUSD",
    name: "Agora USD",
    decimals: 6,
    kind: "erc20",
    categories: ["verified", "stable"],
  },

  // === LIQUID STAKING (LST) ===
  {
    address: "0x0c65a0bc65a5d819235b71f554d210d3f80e0852" as Address,
    symbol: "aprMON",
    name: "aPriori Staked MON",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "lst"],
  },
  {
    address: "0x8498312a6b3cbd158bf0c93abdcf29e6e4f55081" as Address,
    symbol: "gMON",
    name: "Magma Staked MON",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "lst"],
  },
  {
    address: "0xa3227c5969757783154c60bf0bc1944180ed81b9" as Address,
    symbol: "sMON",
    name: "Staked MON",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "lst"],
  },
  {
    address: "0x1b68626dca36c7fe922fd2d55e4f631d962de19c" as Address,
    symbol: "shMON",
    name: "Shmonad Staked MON",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "lst"],
  },

  // === BRIDGED ===
  {
    address: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242" as Address,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "bridged"],
  },
  {
    address: "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as Address,
    symbol: "WBTC",
    name: "Wrapped Bitcoin",
    decimals: 8,
    kind: "erc20",
    categories: ["verified", "bridged"],
  },
  {
    address: "0x10aeaf63194db8d453d4d85a06e5efe1dd0b5417" as Address,
    symbol: "wstETH",
    name: "Wrapped stETH",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "bridged"],
  },
  {
    address: "0xea17e5a9efebf1477db45082d67010e2245217f1" as Address,
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
    kind: "erc20",
    categories: ["verified", "bridged"],
  },

  // === SYNTHETIC ===
  {
    address: "0xe85411c030fb32a9d8b14bbbc6cb19417391f711" as Address,
    symbol: "suBTC",
    name: "Synthetic Bitcoin",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "synthetic"],
  },
  {
    address: "0x1c22531aa9747d76fff8f0a43b37954ca67d28e0" as Address,
    symbol: "suETH",
    name: "Synthetic Ether",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "synthetic"],
  },

  // === MEME (verified) ===
  {
    address: "0x350035555e10d9afaf1566aaebfced5ba6c27777" as Address,
    symbol: "CHOG",
    name: "Chog",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "meme"],
  },
  {
    address: "0xb5f73846a656232d5d251ab1048bca88d1507777" as Address,
    symbol: "MCA",
    name: "Moyaki Cats",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "meme"],
  },
  {
    address: "0x3842751a46d23b41a47e702473dff316e6237777" as Address,
    symbol: "143",
    name: "143",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "meme"],
  },

  // === OTHER ===
  {
    address: "0x788571e0e5067adea87e6ba22a2b738ffdf48888" as Address,
    symbol: "UNIT",
    name: "Unit Protocol",
    decimals: 18,
    kind: "erc20",
    categories: ["verified"],
  },

  // === FROM MONAD-CONTRACTS.JSON TOP-CONTRACTS ===
  {
    address: "0x227aa9ab56564fa381b0d4d9cc4323d0c4adb669" as Address,
    symbol: "ANAGO",
    name: "Anago",
    decimals: 18,
    kind: "erc20",
    categories: ["top-contracts"],
  },
  {
    address: "0x0a332311633c0625f63cfc51ee33fc49826e0a3c" as Address,
    symbol: "APR",
    name: "aPriori",
    decimals: 18,
    kind: "erc20",
    categories: ["top-contracts"],
  },
  {
    address: "0x103222f020e98bba0ad9809a011fdf8e6f067496" as Address,
    symbol: "earnAUSD",
    name: "earnAUSD",
    decimals: 6,
    kind: "erc20",
    categories: ["verified", "stable"],
  },

  // === MANUALLY ADDED ===
  {
    address: "0x1001ff13bf368aa4fa85f21043648079f00e1001" as Address,
    symbol: "LV",
    name: "LeverUp",
    decimals: 18,
    kind: "erc20",
    categories: ["defi"],
  },
  {
    address: "0x1aD7052BB331A0529c1981c3EC2bC4663498A110" as Address,
    symbol: "ALLOCA",
    name: "ALLOCA",
    decimals: 18,
    kind: "erc20",
    categories: ["defi"],
  },
  {
    address: "0x91ce820dD39A2B5639251E8c7837998530Fe7777" as Address,
    symbol: "MOTION",
    name: "Motion",
    decimals: 18,
    kind: "erc20",
    categories: ["verified", "meme"],
  },
];

/**
 * Find verified token by symbol (case-insensitive)
 */
export function getVerifiedTokenBySymbol(
  symbol: string
): TokenInfo | undefined {
  return VERIFIED_TOKENS.find(
    (t) => t.symbol.toLowerCase() === symbol.toLowerCase()
  );
}

/**
 * Find verified token by address (case-insensitive)
 */
export function getVerifiedTokenByAddress(
  address: string
): TokenInfo | undefined {
  return VERIFIED_TOKENS.find(
    (t) => t.address.toLowerCase() === address.toLowerCase()
  );
}
