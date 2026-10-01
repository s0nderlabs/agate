// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateIndex} from "../interfaces/IAgateIndex.sol";

/// Storage layout of AgateIndex (BUILD-SPEC 4.3). A slot state is packed into a uint64:
/// bits 0..31 e, 32..39 miss, bit 40 inMedian, bit 41 wasIn.
struct GpuS {
    bytes32 recipeHash;
    uint8 nSlots; // 0 = not registered
    uint8 nFamilies;
    uint32 firstDay;
    uint64 registeredAt;
    uint64 lastCarryAt;
    uint32 head;
    bool frExists;
    uint32 frDay;
    uint8[15] family;
    uint8[15] famQ;
    uint32[15] liveFrom;
    uint32[15] liveUntil;
    uint64[15] base; // state before the newest record
    uint64[15] last; // state after the newest record
}

/// One writer's accumulators for one (gpu, day), kept for ever: per slot a uint40 sum and a uint8 count, five slots
/// per word (slot i at word i / 5, bit offset 48 * (i % 5), count in the top 8 of its 48 bits).
struct AccS {
    uint256[3] packed;
    uint256 sliceBits;
    uint64 lastPostAt;
    bool late;
    bool anyValid;
}

/// A record in four words. status NONE = no record.
struct RecS {
    address source;
    uint32 value;
    uint32 freshMedian;
    IAgateIndex.Status status;
    uint8 fresh;
    uint8 quorum;
    uint8 held;
    address attestedBy;
    uint64 postedAt;
    bool late;
    bool incomplete;
    bool changed;
    bool needsSign;
    uint64 finalAt;
    uint64 attestedAt;
    bool dropped;
    bytes32 digest;
}

/// Everything the index stores. One instance, shared by the contract and its linked libraries.
struct Store {
    address owner;
    address[2] writers;
    address attester;
    address[2] guardians;
    address forwarder;
    IAgateIndex.WriterMode mode;
    mapping(address => bool) suspended;
    mapping(bytes32 => uint64) queued;
    mapping(bytes32 => GpuS) gpus;
    mapping(bytes32 => mapping(uint32 => RecS)) recs;
    mapping(bytes32 => mapping(uint32 => mapping(address => AccS))) accs;
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) voided;
    mapping(bytes32 => mapping(uint32 => uint64)) reopenedAt;
}

/// The deploy-time profile (the index's immutables), passed to the libraries.
struct Prof {
    uint256 day;
    uint256 slices;
    uint256 slice;
    uint256 minReadings;
    uint256 qMin;
    bool signAll;
    uint256 epochTs;
    uint256 epochDay;
    uint64 chainSelector;
    uint256 tPend;
    uint256 fullBits;
}

/// The result of the daily formula (4.6) for one writer.
struct Calc {
    uint32[] p;
    IAgateIndex.Kind[] kinds;
    uint8[] counts;
    IAgateIndex.SlotState[] post;
    uint32 value;
    uint32 freshMedian;
    uint8 fresh;
    uint8 quorum;
    uint8 held;
    IAgateIndex.Status status;
    bool changed;
    bool complete;
    bool late;
    bytes32 digest;
}
