// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

uint256 constant U = 1_000_000;               // base units per token; u per dollar
uint256 constant LOT = 100;                   // token base units per Kuru size unit
uint256 constant GRID = 50_000;               // F and C grid ($0.05)
uint256 constant LAST_RESORT_DAYS = 60;
uint256 constant LAST_RESORT_FLOOR = 3 days;  // real seconds: lastResort = max(LAST_RESORT_DAYS * day, this)
uint256 constant FIX_CALL_GAS = 100_000;      // gas forwarded to each finalFix call
uint256 constant SYNC_ROUND_GAS = 30_000;     // a round for an ended day needs FIX_CALL_GAS * 64 / 63 + this left, else SyncGasLow
uint256 constant MAX_Q = type(uint64).max;    // largest position size

// Kuru V1 market parameters (BUILD-SPEC 7)
uint8 constant KURU_TYPE_ERC20 = 0;
uint96 constant KURU_SIZE_PRECISION = 10_000;
uint32 constant KURU_PRICE_PRECISION = 1_000_000;
uint32 constant KURU_TICK_SIZE = 10_000;
uint96 constant KURU_MIN_SIZE = 10_000;
uint96 constant KURU_MAX_SIZE = 10_000_000_000;
uint96 constant KURU_AMM_SPREAD = 30;
uint8 constant KURU_MARKET_ACTIVE = 0;        // OrderBook.MarketState.ACTIVE

// FixApplied flag bits
uint8 constant FLAG_LATE = 1;
uint8 constant FLAG_INCOMPLETE = 2;
uint8 constant FLAG_FORCED = 4;
uint8 constant FLAG_BELOW_FLOOR = 8;
uint8 constant FLAG_ABOVE_CAP = 16;
uint8 constant FLAG_CARRIED = 32;

enum Side {
    LONG,
    SHORT
}

enum BandGrade {
    RULE,
    STALE,
    SEEDED
}

enum Venue {
    NONE,
    KURU_V1,
    OTHER
}

enum CloseKind {
    FINAL,
    WITH_TOKEN,
    UNSTREAMED
}

enum Flow {
    OPEN_LONG,
    OPEN_LONG_DAILY,
    OPEN_SHORT,
    CLOSE_LONG,
    CLOSE_SHORT,
    CLOSE_LONG_DAILY
}

/// Everything a series is born with. Immutable.
struct SeriesTerms {
    address index;
    address dollar;
    address factory;
    address router; // the factory's router: the only caller that may open a SHORT position for another owner
    bytes32 gpuId;
    bytes32 recipeHash;
    uint32 month; // year * 12 + (month - 1)
    uint32 startDay; // index dayId of the 1st
    uint8 n; // days in the month
    uint64 startTs; // index.dayStart(startDay)
    uint32 day; // index DAY, seconds
    uint64 lastResort; // max(LAST_RESORT_DAYS * day, LAST_RESORT_FLOOR)
    uint32 floor; // F, u per GPU-hour
    uint32 cap; // C
    uint32 x0; // last-resort fallback start value
    BandGrade bandGrade;
    uint8 anchorCarried;
    uint8 anchorMinFresh;
    bool anchorLate;
}

/// One pay-me-daily position. owner == address(0): none.
struct Position {
    address owner;
    Side side;
    bool daily;
    uint8 openedK;
    address payee;
    uint64 q;
    address operator;
    uint96 paid;
}

/// What list() would record (factory view).
struct Listing {
    uint256 sum5;
    BandGrade bandGrade;
    uint8 anchorCarried;
    uint8 anchorMinFresh;
    bool anchorLate;
    uint32 x0;
    uint32 floor;
    uint32 cap;
}

/// An optional EIP-2612 permit for the router, signed by msg.sender. deadline == 0: none.
struct Permit {
    uint256 value;
    uint256 deadline;
    uint8 v;
    bytes32 r;
    bytes32 s;
}
