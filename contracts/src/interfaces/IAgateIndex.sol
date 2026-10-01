// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReceiver} from "./IReceiver.sol";

// Units: every price is an integer number of u (1 u = $0.000001, one USDC base unit) per GPU-hour.
uint32 constant TICK = 10_000; // $0.01: every reading, slot value, family value and fix is whole cents
uint32 constant P_MIN = 100_000; // $0.10
uint32 constant P_MAX = 1_000_000_000; // $1,000
uint8 constant MAX_SLOTS = 15;
uint8 constant HOLD_DAYS = 5; // computed days a dark IN slot is held before it leaves
uint8 constant SHADOW_DAYS = 5; // days before liveFrom from which a queued slot's readings count (= HOLD_DAYS)
uint32 constant NEVER = type(uint32).max; // liveFrom / liveUntil "not set"
uint8 constant REPORT_VERSION = 1;
uint8 constant N_WRITERS = 2; // writer slot 0 = primary (CRE), 1 = standby; fixed order for C3
uint8 constant N_GUARDIANS = 2;

/// @title IAgateIndex: the wall
/// @notice Writers post hourly readings; the contract computes one daily fix per GPU from ONE writer's stored
/// readings; a changed fix needs a countersign (attester or guardian); nobody can type a price.
/// Check names (A1..A3, E1..E9, C1..C7) follow docs/wall/BUILD-SPEC.md section 4.
interface IAgateIndex is IReceiver {
    // ------------------------------------------------------------------ enums

    enum Kind {
        OUT,
        FRESH,
        HELD
    }

    /// NONE: no record. FULL / DEGRADED / DEMO: a computed record graded by fresh families (5+, 3-4, below 3).
    /// CARRIED: carryDay repeated the previous value.
    enum Status {
        NONE,
        FULL,
        DEGRADED,
        DEMO,
        CARRIED
    }

    /// How a report that arrives through the forwarder names its writer (check A2).
    /// TX_ORIGIN: the demo path (CRE simulate --broadcast): tx.origin is the writer.
    /// WORKFLOW_OWNER: the network path (a real DON): the workflow owner in the metadata is the writer.
    enum WriterMode {
        TX_ORIGIN,
        WORKFLOW_OWNER
    }

    enum ActionKind {
        WRITER, // slot 0..1, addr (zero = remove)
        ATTESTER, // addr (zero = remove)
        GUARDIAN, // slot 0..1, addr (zero = remove)
        FORWARDER, // addr, mode
        LIVE_FROM, // gpuId, slot, day
        LIVE_UNTIL, // gpuId, slot, day
        OWNER // addr
    }

    /// Why one entry of a report was skipped (the other entries still apply).
    enum Skip {
        NONE,
        E1_GPU_OR_LENGTH,
        E2_SLICE,
        E3_DAY_CLOSED,
        E4_VOIDED,
        E5_READ_AT_OUTSIDE_SLICE,
        E6_READ_AT_FUTURE,
        E7_DUPLICATE
    }

    // ------------------------------------------------------------------ structs

    /// One slice of readings of one GPU. values[i] is slot i's reading in u (0 = no reading).
    /// report = abi.encode(uint8 version, uint64 chainSelector, address index, Entry[] entries)
    struct Entry {
        bytes32 gpuId;
        uint32 dayId;
        uint8 slice;
        uint64 readAt;
        uint32[] values;
    }

    struct InitParams {
        uint32 day; // seconds per index day (86,400 in production)
        uint8 slices; // readings per day (24 in production)
        uint8 minReadings; // readings a slot needs that day to be fresh (12 in production)
        uint8 qMin; // families needed for a fix (3 in production; 1 allowed only with demoLabel)
        bool demoLabel; // the index is labelled DEMO
        bool signAll; // every computed record needs a countersign; required when PEND_FLOOR > day/2 (FAST)
        uint64 epochTs; // 0 in production; the deployment second on a demo clock
        uint32 epochDay; // 0 in production; the day-count (since 1970-01-01) of a real 1st of a month on a demo clock
        uint64 chainSelector; // the CRE chain selector carried in every report (check A3)
        address owner;
        address[2] writers; // [primary, standby]; standby may be zero
        address attester;
        address[2] guardians; // second may be zero
        address forwarder;
        WriterMode writerMode;
    }

    /// Every duration is derived from day (BUILD-SPEC 2.2, rule R v4.3): slice = day/slices,
    /// gap = max(1, slices/8), PEND_FLOOR = gap*slice + 60; tPend = max(day/4, PEND_FLOOR), or day/4 when signAll and
    /// PEND_FLOOR > day/2; closeGrace = slice; grace = day; holdMove = 7 day; holdMin = 3 day/4; step = day/6;
    /// reopenWait = day/4; timelock = 2 day.
    struct Clocks {
        uint32 day;
        uint32 slice;
        uint32 tPend;
        uint32 closeGrace;
        uint32 grace;
        uint32 holdMove;
        uint32 holdMin;
        uint32 step;
        uint32 reopenWait;
        uint32 timelock;
        uint8 slices;
        uint8 minReadings;
        uint8 qMin;
        bool demoLabel;
        bool signAll;
        uint64 epochTs;
        uint32 epochDay;
        uint64 chainSelector;
    }

    struct GpuConfig {
        bytes32 recipeHash;
        uint8 nSlots;
        uint8 nFamilies;
        uint32 firstDay;
        uint64 registeredAt;
        uint64 lastCarryAt;
        uint32 head; // the next day to close
    }

    /// A slot's state after a record: held value, computed days since last fresh (0..HOLD_DAYS+1), in the median,
    /// ever been in the median.
    struct SlotState {
        uint32 e;
        uint8 miss;
        bool inMedian;
        bool wasIn;
    }

    struct Record {
        uint32 value; // the fix, u, on the cent grid
        Status status;
        uint8 fresh; // families with famQ FRESH slots
        uint8 quorum; // families with famQ IN slots (0 if no slot is FRESH)
        uint8 held; // HELD slots
        uint32 freshMedian; // cent median of the fresh families alone (display only); 0 if none
        bool late; // the source posted some slice 2+ slices after the slice began
        bool incomplete; // the source did not post every slice
        bool changed; // value, membership or entry changed (4.6)
        bool needsSign; // changed, or signAll, or source is not the day's first writer: finalAt 0 until attested
        bool dropped; // CARRIED after an unsigned needsSign record was dropped
        address source; // zero for CARRIED
        uint64 postedAt; // close time (a select keeps the original postedAt)
        uint64 finalAt; // 0 = not final yet (needsSign and not attested); final when block.timestamp >= finalAt
        uint64 attestedAt;
        address attestedBy;
        bytes32 digest; // zero for CARRIED
    }

    struct RecordDetail {
        Record rec;
        uint32[] p; // each slot's fresh day value (0 if not fresh)
        Kind[] kinds;
        uint8[] counts; // each slot's reading count for the day
        SlotState[] post; // each slot's state after this record
    }

    /// One writer's accumulators for one (gpuId, day). Kept for ever (never deleted), so any record can be
    /// recomputed offchain later (rule R8 after a select).
    struct Readings {
        uint40[] sums;
        uint8[] counts;
        uint256 sliceBits; // bit h set: this writer posted slice h (even with all values 0)
        bool late;
        bool anyValid; // at least one valid value (C3 "first writer")
        uint64 lastPostAt;
    }

    /// A timelocked owner change. id = keccak256(abi.encode(action)). Fields the kind does not use must be zero
    /// (BadAction). A queued action never expires; cancel stale ones after an OWNER rotation (BUILD-SPEC 13.4).
    struct Action {
        ActionKind kind;
        uint8 slot;
        address addr;
        bytes32 gpuId;
        uint32 day;
        WriterMode mode;
    }

    // ------------------------------------------------------------------ events

    event GpuRegistered(
        bytes32 indexed gpuId,
        bytes32 recipeHash,
        uint32 firstDay,
        uint8[] family,
        uint8[] famQ,
        uint32 liveAtStartMask
    );
    /// Every accepted entry. values exactly as posted; validMask bit i = values[i] entered the sums (E8, E8b passed).
    event ReadingsPosted(
        bytes32 indexed gpuId,
        uint32 indexed day,
        address indexed writer,
        uint8 slice,
        uint64 readAt,
        uint32[] values,
        uint32 validMask,
        bool late
    );
    event EntrySkipped(bytes32 indexed gpuId, uint32 indexed day, address indexed writer, uint8 slice, Skip reason);
    /// E8: a nonzero value outside [P_MIN, P_MAX] or off the cent grid (stored as no reading).
    event BadValue(bytes32 indexed gpuId, uint32 indexed day, address indexed writer, uint8 slice, uint8 slot, uint32 value);
    /// C7 summary. Per-slot detail follows in RecordSlots.
    event DayClosed(
        bytes32 indexed gpuId,
        uint32 indexed day,
        address indexed source,
        uint32 value,
        Status status,
        uint8 fresh,
        uint8 held,
        uint32 freshMedian,
        bool changed,
        bool needsSign,
        bool late,
        bool incomplete,
        bytes32 digest
    );
    /// Emitted on every close and every select: the record's per-slot inputs and the state it leaves behind.
    event RecordSlots(
        bytes32 indexed gpuId,
        uint32 indexed day,
        address indexed source,
        bytes32 digest,
        uint32[] p,
        Kind[] kinds,
        uint8[] counts,
        SlotState[] post
    );
    event Attested(
        bytes32 indexed gpuId, uint32 indexed day, address indexed by, address source, bytes32 digest, uint64 finalAt
    );
    event RecordReplaced(
        bytes32 indexed gpuId,
        uint32 indexed day,
        address indexed by,
        address oldSource,
        address newSource,
        uint32 oldValue,
        uint32 newValue,
        bytes32 oldDigest,
        bytes32 newDigest
    );
    event Vetoed(
        bytes32 indexed gpuId, uint32 indexed day, address indexed by, address source, bytes32 digest, uint32 value
    );
    event WriterSuspended(address indexed writer, address indexed by);
    event FixDropped(bytes32 indexed gpuId, uint32 indexed day, address source, uint32 value, bytes32 digest);
    /// missAdvanced bit i: slot i's miss counter advanced by this carry (every eligible writer read it not fresh; 4.9).
    event DayCarried(
        bytes32 indexed gpuId, uint32 indexed day, uint32 value, uint8 carryCase, bool dropped, uint32 missAdvanced
    );
    event DaySkipped(bytes32 indexed gpuId, uint32 indexed day, uint8 carryCase);
    event ActionQueued(bytes32 indexed id, Action action, uint64 eta);
    event ActionExecuted(bytes32 indexed id, Action action);
    event ActionCancelled(bytes32 indexed id);

    // ------------------------------------------------------------------ errors

    error BadInit();
    // report as a whole (the whole report reverts)
    error A1_NotForwarder(address sender);
    error A2_NotActiveWriter(address writer);
    error A3_BadHeader(uint8 version, uint64 chainSelector, address index);
    // closeDay
    error C1_DayNotOver(uint32 day, uint64 closableAt);
    error C2_PreviousNotFinal(uint32 day);
    error C3_BelowQuorum(uint32 day);
    error C4_CallerNotAllowed(address caller, address source);
    // attest / veto / suspend
    error UnknownGpu(bytes32 gpuId);
    error NoPendingRecord(bytes32 gpuId, uint32 day);
    error AlreadyFinal(bytes32 gpuId, uint32 day);
    error AlreadyAttested(bytes32 gpuId, uint32 day);
    error DigestMismatch(bytes32 expected, bytes32 given);
    error NotAttesterOrGuardian(address caller);
    error NotGuardian(address caller);
    error HasCode(address account);
    error SelectNotEligible(address writer); // not active, voided for the day, or no readings
    error SelectBelowQuorum(address writer);
    error SelectIncomplete(address writer); // the attester may only select a complete day (F6)
    error VetoStale(address source, bytes32 digest); // the named record is not the pending one (F2)
    error NotAWriter(address account);
    // carryDay
    error Carry1_NotDroppable(bytes32 gpuId, uint32 day); // needs needsSign, unattested, finalAt 0
    error Carry1_TooEarly(uint64 allowedAt);
    error Carry2_DayNotOver(uint32 day);
    error Carry2_PreviousNotFinal(uint32 day);
    error Carry2_TooEarly(uint64 allowedAt);
    error Carry2_HasQuorum(address writer);
    // owner
    error NotOwner(address caller);
    error GpuExists(bytes32 gpuId);
    error BadSlots();
    error BadFamilies();
    error FirstDayOutOfRange(uint32 firstDay);
    error NothingLive();
    error AlreadyQueued(bytes32 id);
    error NotQueued(bytes32 id);
    error TimelockActive(uint64 eta);
    error BadAction();
    error RoleTaken(address account);
    error ZeroAddress();
    error BadSlot(uint8 slot);
    error LiveFromNotFirstOfMonth(uint32 day);
    error LiveFromTooLate(uint32 day);
    error SlotAlreadyStarted(uint8 slot);
    error SlotWindowNotOpen(uint8 slot);
    error LiveUntilTooEarly(uint32 day);
    error DayBegun(uint32 day);

    // ------------------------------------------------------------------ writers

    /// Direct path (the standby, or any writer's repost): msg.sender is the writer. Same checks as onReport
    /// except A1. onReport (CRE path) is inherited from IReceiver.
    function postReport(bytes calldata report) external;

    // ------------------------------------------------------------------ days

    /// Closes head(gpuId) and nothing else (checks C1..C7). From dayEnd + tPend a quorate first writer is the source,
    /// complete or not (C3, v4.3). Returns the day closed.
    function closeDay(bytes32 gpuId) external returns (uint32 day);

    /// Anyone, one day per call. Case 1 drops an unsigned needsSign record; case 2 carries a no-data day. The carried
    /// state advances the miss counter of each readable slot every eligible writer read not fresh (never past
    /// HOLD_DAYS; e, inMedian, wasIn unchanged). Then tries to close the next day (never reverts because of that
    /// attempt). Returns 1 or 2.
    function carryDay(bytes32 gpuId) external returns (uint8 carryCase);

    // ------------------------------------------------------------------ second key (none writes a value)

    /// Attester or guardian. writer == pending source: countersign (digest must match). Otherwise SELECT:
    /// recompute writer's record at the pending postedAt, require its digest, replace the pending record.
    function attest(bytes32 gpuId, uint32 day, address writer, bytes32 digest) external;

    /// Guardian. Names the record it checked (F2): reverts VetoStale unless source and digest are the pending
    /// record's. Deletes it, voids source's readings of that day, reopens the day. Never suspends.
    function veto(bytes32 gpuId, uint32 day, address source, bytes32 digest) external;

    /// Guardian. The writer posts and closes nothing until the owner appoints it again (rule R6: appoint a new one).
    function suspend(address writer) external;

    // ------------------------------------------------------------------ owner

    /// Immediate and append-only. nSlots = family.length (1..MAX_SLOTS); family[i] < famQ.length; every family
    /// has a slot; 1 <= famQ[f] <= family f's slot count; at least Q_MIN families; firstDay within 31 days of
    /// today; bit i of liveAtStartMask opens slot i at firstDay.
    function registerGpu(
        bytes32 gpuId,
        bytes32 recipeHash,
        uint8[] calldata family,
        uint8[] calldata famQ,
        uint32 firstDay,
        uint32 liveAtStartMask
    ) external;

    function queue(Action calldata action) external returns (bytes32 id);
    function execute(Action calldata action) external;
    function cancel(Action calldata action) external;

    // ------------------------------------------------------------------ views (never revert unless noted)

    /// ok only if a record exists and is final now.
    function finalFix(bytes32 gpuId, uint32 day)
        external
        view
        returns (bool ok, uint32 value, Status status, uint8 fresh, bool late, bool incomplete);

    function record(bytes32 gpuId, uint32 day) external view returns (bool exists, bool isFinal, Record memory rec);

    /// The record C5 would give from writer's stored readings for the pending day (head - 1 while its record is
    /// unfinal and not CARRIED; at its postedAt) or the head day (at block.timestamp). For the pending record's own
    /// source it carries the stored needsSign and finalAt. ok = false for any other day, if not computable or below
    /// quorum.
    function previewRecord(bytes32 gpuId, uint32 day, address writer)
        external
        view
        returns (bool ok, RecordDetail memory detail);

    /// What closeDay would record for the head day right now (C3's source at block.timestamp).
    function previewFix(bytes32 gpuId) external view returns (bool ok, RecordDetail memory detail);

    function firstRecordDay(bytes32 gpuId) external view returns (bool exists, uint32 day);
    function head(bytes32 gpuId) external view returns (uint32);
    function gpu(bytes32 gpuId) external view returns (GpuConfig memory);
    /// State after the newest FINAL record.
    function slotState(bytes32 gpuId, uint8 slot) external view returns (SlotState memory);
    /// base = state before the newest record; last = state after it (pending or final).
    function slotStates(bytes32 gpuId) external view returns (SlotState[] memory base, SlotState[] memory last);
    function slotWindow(bytes32 gpuId, uint8 slot) external view returns (uint32 liveFrom, uint32 liveUntil);
    function familyOf(bytes32 gpuId, uint8 slot) external view returns (uint8 family, uint8 famQ);
    function readings(bytes32 gpuId, uint32 day, address writer) external view returns (Readings memory);
    function isVoided(bytes32 gpuId, uint32 day, address writer) external view returns (bool);
    function reopenedAt(bytes32 gpuId, uint32 day) external view returns (uint64);
    /// The five newest final records are all CARRIED (display only).
    function disrupted(bytes32 gpuId) external view returns (bool);

    /// keccak256(abi.encode(gpuId, day, source, p, kinds, counts, inMedian[], miss[], wasIn[], value)), with the
    /// last three arrays taken from post. The same digest closeDay, attest and veto use.
    function digestOf(
        bytes32 gpuId,
        uint32 day,
        address source,
        uint32[] calldata p,
        Kind[] calldata kinds,
        uint8[] calldata counts,
        SlotState[] calldata post,
        uint32 value
    ) external pure returns (bytes32);

    // roles
    function owner() external view returns (address);
    function writers() external view returns (address[2] memory);
    function attester() external view returns (address);
    function guardians() external view returns (address[2] memory);
    function isSuspended(address writer) external view returns (bool);
    function forwarder() external view returns (address forwarderAddress, WriterMode mode);
    function queuedEta(bytes32 id) external view returns (uint64 eta); // 0 = not queued
    function actionId(Action calldata action) external pure returns (bytes32);

    // clock
    function clocks() external view returns (Clocks memory);
    function dayId(uint64 t) external view returns (uint32);
    function dayStart(uint32 day) external view returns (uint64);
}
