// The developer API's OpenAPI 3.1 description (GET /v1/openapi.json). Keep it in step with developer.ts and
// docs/site/08-api.md; developer.test.ts checks every route here answers.

/** requests per IP per minute, over every /v1 route (developer.ts enforces it) */
export const V1_LIMIT_PER_MIN = 120;
const usd = { type: "number", description: "US dollars per GPU-hour" } as const;
const usdOrNull = { type: ["number", "null"], description: "US dollars per GPU-hour; null when there is none" } as const;
const iso = { type: "string", format: "date-time" } as const;
const isoOrNull = { type: ["string", "null"], format: "date-time" } as const;
const gpu = { type: "string", enum: ["H100", "H200", "B200", "B300", "A100", "L40S"] } as const;
const stamp = { readAt: iso, ageMs: { type: "integer", description: "how old the server's read was when it answered" } } as const;
const err = { description: "error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } as const;
const ok = (ref: string) => ({ description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } });
const gpuParam = { name: "gpu", in: "path", required: true, schema: gpu, description: "case does not matter" } as const;
const limited = { 429: err } as const;
const monthParam = { name: "month", in: "path", required: true, schema: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" }, example: "2026-11" } as const;

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "agate developer API",
    version: "1",
    description:
      "Read-only market data for agate, the open onchain price of renting a GPU for an hour, on Monad testnet. No key. " +
      `${V1_LIMIT_PER_MIN} requests a minute per IP (429 with retry-after past it). Prices are US dollars per GPU-hour, sizes GPU-hours, times ISO 8601 UTC. ` +
      "Every token is a test asset with no monetary value.",
  },
  servers: [
    { url: "https://agate.elpabl0.xyz/api", description: "the app's address" },
    { url: "https://agate-1.tailf06dd7.ts.net", description: "agate's server" },
  ],
  paths: {
    "/v1/prices": { get: { summary: "Today's index price of every GPU, with every source", responses: { 200: ok("Prices"), 503: err, ...limited } } },
    "/v1/prices/{gpu}": { get: { summary: "One GPU's price, sources and daily history", parameters: [gpuParam], responses: { 200: ok("PriceWithHistory"), 400: err, 404: err, 503: err, ...limited } } },
    "/v1/markets": { get: { summary: "Every month on sale, with its range and best prices", responses: { 200: ok("Markets"), 503: err, ...limited } } },
    "/v1/markets/{gpu}/{month}": { get: { summary: "One month with its order book", parameters: [gpuParam, monthParam], responses: { 200: ok("MonthWithBook"), 400: err, 404: err, 503: err, ...limited } } },
    "/v1/markets/{gpu}/{month}/trades": {
      get: {
        summary: "Recent trades of one month, newest first",
        parameters: [gpuParam, monthParam, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }],
        responses: { 200: ok("Trades"), 400: err, 404: err, 503: err, ...limited },
      },
    },
    "/v1/markets/{gpu}/{month}/candles": { get: { summary: "Hourly candles of one month from its first trade", parameters: [gpuParam, monthParam], responses: { 200: ok("Candles"), 400: err, 404: err, 503: err, ...limited } } },
    "/v1/status": { get: { summary: "When each price was last made final and how many sources it counted", responses: { 200: ok("Status"), 503: err, ...limited } } },
  },
  components: {
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
      Source: {
        type: "object",
        properties: {
          company: { type: "string", description: "the cloud whose own price page was read" },
          price: usdOrNull,
          counted: { type: "boolean", description: "in today's median" },
          reserve: { type: "boolean", description: "held in reserve: counted only when a main source fails" },
          page: {
            type: ["object", "null"],
            description:
              "the newest clean reading of this cloud's price page on the price's date by the watcher (the independent reader the attester checks each day against); null when there is none",
            properties: {
              sha256: { type: "string", pattern: "^[0-9a-f]{64}$", description: "hex sha256 of the page's bytes as fetched" },
              fetchedAt: iso,
              price: { ...usd, description: "the price read from that page, US dollars per GPU-hour" },
            },
          },
        },
      },
      Price: {
        type: "object",
        properties: {
          gpu,
          price: usdOrNull,
          date: { type: ["string", "null"], format: "date", description: "the UTC day the price is of" },
          previousPrice: usdOrNull,
          change: { type: ["number", "null"] },
          finalAt: isoOrNull,
          nextCloseAt: iso,
          nextFinalAt: { ...iso, description: "a day's price is published at its close and final 6 hours later; a changed price also needs a second, independent reader's countersign" },
          sourcesCounted: { type: "integer" },
          panelSize: { type: "integer" },
          sources: { type: "array", items: { $ref: "#/components/schemas/Source" } },
          tradable: { type: "boolean", description: "false for the price-only GPUs" },
        },
      },
      Day: { type: "object", properties: { date: { type: "string", format: "date" }, price: usd, status: { type: "string", enum: ["final", "carried"] } } },
      Prices: { type: "object", properties: { ...stamp, prices: { type: "array", items: { $ref: "#/components/schemas/Price" } } } },
      PriceWithHistory: {
        allOf: [
          { $ref: "#/components/schemas/Price" },
          {
            type: "object",
            properties: {
              ...stamp,
              history: { type: "array", items: { $ref: "#/components/schemas/Day" }, description: "onchain days, oldest first" },
              beforeOnchain: { type: "array", items: { $ref: "#/components/schemas/Day" }, description: "days computed from our logger before the index went onchain; nothing settles on them" },
            },
          },
        ],
      },
      Month: {
        type: "object",
        properties: {
          gpu,
          month: { type: "string", example: "2026-11" },
          symbol: { type: "string" },
          name: { type: "string" },
          phase: { type: "string", enum: ["upcoming", "trading", "paying", "settled"] },
          opensOn: { ...iso, description: "upcoming months only" },
          floor: { ...usdOrNull, description: "US dollars per GPU-hour; null while upcoming" },
          ceiling: { ...usdOrNull, description: "US dollars per GPU-hour; null while upcoming" },
          days: { type: "integer" },
          startsAt: iso,
          closesAt: iso,
          listedAt: isoOrNull,
          bid: usdOrNull,
          ask: usdOrNull,
          last: { ...usdOrNull, description: "the last trade's price; null before the first trade" },
          lastTradeAt: isoOrNull,
          openInterest: { type: "number", description: "GPU-hours outstanding" },
          contracts: {
            type: "object",
            description: "null until the month is listed (kuruMarket: until its book is recorded)",
            properties: { series: { type: ["string", "null"] }, token: { type: ["string", "null"] }, kuruMarket: { type: ["string", "null"] } },
          },
        },
      },
      Level: { type: "object", properties: { price: usd, size: { type: "number", description: "GPU-hours" } } },
      Markets: { type: "object", properties: { ...stamp, markets: { type: "array", items: { $ref: "#/components/schemas/Month" } } } },
      MonthWithBook: {
        allOf: [
          { $ref: "#/components/schemas/Month" },
          {
            type: "object",
            properties: {
              ...stamp,
              book: {
                type: "object",
                properties: {
                  bids: { type: "array", items: { $ref: "#/components/schemas/Level" }, description: "best first" },
                  asks: { type: "array", items: { $ref: "#/components/schemas/Level" }, description: "best first" },
                  spread: { type: "number" },
                },
              },
            },
          },
        ],
      },
      Trades: {
        type: "object",
        properties: {
          gpu,
          month: { type: "string" },
          trades: {
            type: "array",
            items: {
              type: "object",
              properties: { at: iso, side: { type: "string", enum: ["buy", "sell"], description: "the taker's side" }, price: usd, size: { type: "number" }, txHash: { type: "string" } },
            },
          },
        },
      },
      Candles: {
        type: "object",
        properties: {
          gpu,
          month: { type: "string" },
          interval: { type: "string", enum: ["1h"] },
          candles: {
            type: "array",
            items: { type: "object", properties: { t: iso, open: usd, high: usd, low: usd, close: usd, volume: { type: "number", description: "GPU-hours" } } },
          },
        },
      },
      Status: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          ...stamp,
          chainId: { type: "integer" },
          index: { type: "string", description: "the index contract" },
          gpus: {
            type: "array",
            items: {
              type: "object",
              properties: { gpu, date: { type: ["string", "null"] }, finalAt: isoOrNull, nextCloseAt: iso, nextFinalAt: iso, sourcesCounted: { type: "integer" }, panelSize: { type: "integer" } },
            },
          },
        },
      },
    },
  },
} as const;
