import { type Address, type Hex } from "viem";
import { type LeverUpPairMetadata } from "./types.js";

export const LEVERUP_DIAMOND = "0xea1b8E4aB7f14F7dCA68c5B214303B13078FC5ec" as Address;
export const PYTH_CONTRACT = "0x2880aB155794e7179c9eE2e38200202908C17B43" as Address;

// Collateral token addresses (Monad Mainnet)
export const USDC_ADDRESS = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address;
export const LVUSD_ADDRESS = "0xFD44B35139Ae53FFF7d8F2A9869c503D987f00d1" as Address;
export const LVMON_ADDRESS = "0x91b81bfbe3A747230F0529Aa28d8b2Bc898E6D56" as Address;
export const NATIVE_MON_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const WMON_ADDRESS = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address;

// WMON ABI for wrapping/unwrapping native MON
export const WMON_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: []
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: []
  }
] as const;

export const LIQUIDATION_LOSS_RATE = 8500n;

// High-leverage (degen mode) constants
// 500BTC/500ETH pairs ONLY support these specific leverage values
export const DEGEN_MODE_LEVERAGE_OPTIONS = [500, 750, 1001] as const;
export const DEGEN_MODE_MIN_LEVERAGE = 500;

// TP limits enforced by contract
export const TP_LIMIT_LOW_LEVERAGE = 500; // Max 500% TP for leverage < 50x
export const TP_LIMIT_HIGH_LEVERAGE = 300; // Max 300% TP for leverage >= 50x
export const TP_LEVERAGE_THRESHOLD = 50; // Leverage threshold for TP limits

export const PYTH_HERMES_URL = "https://hermes.pyth.network";

export const READER_ABI = [
  {
    type: "function",
    inputs: [
      { type: "address", name: "user" },
      { type: "address", name: "pairBase" }
    ],
    name: "getPositionsV2",
    outputs: [
      {
        components: [
          { type: "bytes32", name: "positionHash" },
          { type: "string", name: "pair" },
          { type: "address", name: "pairBase" },
          { type: "address", name: "tokenIn" },
          { type: "address", name: "marginToken" },
          { type: "bool", name: "isLong" },
          { type: "uint96", name: "margin" },
          { type: "uint128", name: "qty" },
          { type: "uint128", name: "entryPrice" },
          { type: "uint128", name: "stopLoss" },
          { type: "uint128", name: "takeProfit" },
          { type: "uint96", name: "openFee" },
          { type: "uint96", name: "executionFee" },
          { type: "int256", name: "fundingFee" },
          { type: "uint32", name: "timestamp" },
          { type: "uint96", name: "holdingFee" }
        ],
        type: "tuple[]",
        name: ""
      }
    ],
    stateMutability: "view"
  }
] as const;

export const TRADING_PORTAL_ABI = [
  {
    inputs: [
      {
        components: [
          { type: "address", name: "pairBase" },
          { type: "bool", name: "isLong" },
          { type: "address", name: "tokenIn" },
          { type: "address", name: "lvToken" },
          { type: "uint96", name: "amountIn" },
          { type: "uint128", name: "qty" },
          { type: "uint128", name: "price" },
          { type: "uint128", name: "stopLoss" },
          { type: "uint128", name: "takeProfit" },
          { type: "uint24", name: "broker" }
        ],
        name: "data",
        type: "tuple"
      },
      { type: "bytes[]", name: "priceUpdateData" }
    ],
    name: "openMarketTradeWithPyth",
    outputs: [{ type: "bytes32", name: "tradeHash" }],
    stateMutability: "payable",
    type: "function"
  },
  {
    name: "closeTrade",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "tradeHash", type: "bytes32" }],
    outputs: []
  },
  {
    // addMargin(bytes32,address,uint96) - selector 0xe1379570
    // Discovered from frontend tx: 0x442a3a14efd64312bd06f18ba9446bcd19d1de08f97969af41749b641e5c238e
    // NOTE: Only adding margin is supported - withdrawal not allowed by contract
    name: "addMargin",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "tradeHash", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint96" }
    ],
    outputs: []
  },
  {
    // updateTradeTpAndSl(bytes32,uint128,uint128) - selector 0x2f745df6
    // Discovered from frontend tx: 0xed96b394b1938b163b1de31b994b8851b7038df9de82f5c324c8e93709a8ccaa
    name: "updateTradeTpAndSl",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tradeHash", type: "bytes32" },
      { name: "takeProfit", type: "uint128" },
      { name: "stopLoss", type: "uint128" }
    ],
    outputs: []
  }
] as const;

// Limit Order ABI - uses same OpenDataInput struct as market orders
// The only difference: `price` field = trigger price (order fills when market reaches this)
export const LIMIT_ORDER_ABI = [
  {
    inputs: [
      {
        components: [
          { type: "address", name: "pairBase" },
          { type: "bool", name: "isLong" },
          { type: "address", name: "tokenIn" },
          { type: "address", name: "lvToken" },
          { type: "uint96", name: "amountIn" },
          { type: "uint128", name: "qty" },
          { type: "uint128", name: "price" }, // TRIGGER price for limit orders
          { type: "uint128", name: "stopLoss" },
          { type: "uint128", name: "takeProfit" },
          { type: "uint24", name: "broker" }
        ],
        name: "data",
        type: "tuple"
      },
      { type: "bytes[]", name: "priceUpdateData" }
    ],
    name: "openLimitOrderWithPyth",
    outputs: [{ type: "bytes32", name: "orderHash" }],
    stateMutability: "payable",
    type: "function"
  },
  {
    name: "cancelLimitOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderHash", type: "bytes32" }],
    outputs: []
  },
  {
    name: "batchCancelLimitOrders",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderHashes", type: "bytes32[]" }],
    outputs: []
  }
] as const;

// Limit Order Reader ABI - for fetching pending limit orders
export const LIMIT_ORDER_READER_ABI = [
  {
    type: "function",
    inputs: [
      { type: "address", name: "user" },
      { type: "address", name: "pairBase" }
    ],
    name: "getLimitOrders",
    outputs: [
      {
        components: [
          { type: "bytes32", name: "orderHash" },
          { type: "string", name: "pair" },
          { type: "address", name: "pairBase" },
          { type: "bool", name: "isLong" },
          { type: "address", name: "tokenIn" },
          { type: "address", name: "lvToken" },
          { type: "uint96", name: "amountIn" },
          { type: "uint128", name: "qty" },
          { type: "uint128", name: "limitPrice" },
          { type: "uint128", name: "stopLoss" },
          { type: "uint128", name: "takeProfit" },
          { type: "uint24", name: "broker" },
          { type: "uint32", name: "timestamp" }
        ],
        type: "tuple[]",
        name: ""
      }
    ],
    stateMutability: "view"
  }
] as const;

export const PYTH_ABI = [
  {
    name: "getUpdateFee",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "updateData", type: "bytes[]" }],
    outputs: [{ name: "fee", type: "uint256" }]
  }
] as const;

export const SUPPORTED_PAIRS: LeverUpPairMetadata[] = [
  {
    pair: "BTC/USD",
    pairBase: "0xcf5a6076cfa32686c0df13abada2b40dec133f1d",
    pythId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    category: "Crypto"
  },
  {
    pair: "ETH/USD",
    pairBase: "0xb5a30b0fdc5ea94a52fdc42e3e9760cb8449fb37",
    pythId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    category: "Crypto"
  },
  {
    pair: "MON/USD",
    pairBase: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
    pythId: "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1",
    category: "Crypto"
  },
  {
    pair: "SOL/USD",
    pairBase: "0x0a3ec4fc70eaf64faf6eeda4e9b2bd4742a78546",
    pythId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    category: "Crypto"
  },
  {
    pair: "XRP/USD",
    pairBase: "0xaeb724422620edb430dcaf22aeeff2e9388a578c",
    pythId: "0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
    category: "Crypto"
  },
  {
    pair: "QQQ/USD",
    pairBase: "0xb589511c51d1ffda5d943ac1c9733e112abeff7b",
    pythId: "0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d",
    category: "Indices"
  },
  {
    pair: "SPY/USD",
    pairBase: "0xcb8900160bd4a86d3b80f5ad5a44ee15823b0592",
    pythId: "0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5",
    category: "Indices"
  },
  {
    pair: "AAPL/USD",
    pairBase: "0x3a54a9a690616fbc26cfc409bf11f89d51f1d57a",
    pythId: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    category: "Stocks"
  },
  {
    pair: "AMZN/USD",
    pairBase: "0x6c755094f1cdd95e2e4170549dc12e7555151536",
    pythId: "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
    category: "Stocks"
  },
  {
    pair: "TSLA/USD",
    pairBase: "0x0a8f1f385fed9c77a2e0daa363ccc865e971bdbe",
    pythId: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
    category: "Stocks"
  },
  {
    pair: "NVDA/USD",
    pairBase: "0xe108948b9667048232851f26a1427d3a908b22da",
    pythId: "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
    category: "Stocks"
  },
  {
    pair: "META/USD",
    pairBase: "0x0057355892fab25ddc63a7482ec1696d6ada6703",
    pythId: "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
    category: "Stocks"
  },
  {
    pair: "MSFT/USD",
    pairBase: "0xb2023082f01404dd0ce6937cab03c4f5d6db9ba8",
    pythId: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
    category: "Stocks"
  },
  {
    pair: "GOOG/USD",
    pairBase: "0x9a4f772de1a5f6df5913fa2c98dd7177eaa23dc2",
    pythId: "0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2",
    category: "Stocks"
  },
  {
    pair: "EUR/USD",
    pairBase: "0xa9226449042e36bf6865099eec57482aa55e3ad0",
    pythId: "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
    category: "Forex"
  },
  {
    pair: "USD/JPY",
    pairBase: "0x35b8bafff3570683af968b8d36b91b1a19465141",
    pythId: "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52",
    category: "Forex"
  },
  {
    pair: "XAU/USD",
    pairBase: "0x7c687a3207cd9c05b4b11d8dd7ac337919c22001",
    pythId: "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
    category: "Commodities"
  },
  {
    pair: "XAG/USD",
    pairBase: "0x5ccc5c04130d272bf07d6e066f4cae40cfc03136",
    pythId: "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e",
    category: "Commodities"
  },
  {
    pair: "500BTC/USD",
    pairBase: "0x0000000000000000000000000000000000000003" as Address,
    pythId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    category: "Crypto",
    isHighLeverage: true
  },
  {
    pair: "500ETH/USD",
    pairBase: "0x0000000000000000000000000000000000000004" as Address,
    pythId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    category: "Crypto",
    isHighLeverage: true
  }
];
