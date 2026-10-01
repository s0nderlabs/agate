// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAgateIndex, NEVER} from "./interfaces/IAgateIndex.sol";
import {IReceiver, IERC165} from "./interfaces/IReceiver.sol";
import {Store, GpuS, AccS, RecS, Prof} from "./lib/IndexTypes.sol";
import {IndexMath} from "./lib/IndexFormula.sol";
import {IndexLib} from "./lib/IndexLib.sol";
import {IndexDays} from "./lib/IndexDays.sol";
import {IndexReports} from "./lib/IndexReports.sol";
import {IndexViews} from "./lib/IndexViews.sol";
import {IndexAdmin} from "./lib/IndexAdmin.sol";

/// @title AgateIndex: the wall (BUILD-SPEC section 4, rule R v4.3)
/// @notice Writers post hourly readings into their own accumulators; closeDay computes one daily fix per GPU from
/// ONE writer's stored readings; a needsSign record needs the attester's or a guardian's countersign; nobody types
/// a price. No proxy, no pause, no upgrade, no external calls. The logic lives in linked libraries (IndexReports,
/// IndexDays, IndexViews, IndexAdmin) that run in this contract's storage by DELEGATECALL.
contract AgateIndex is IAgateIndex {
    using IndexLib for Store;
    using IndexLib for RecS;

    // ------------------------------------------------------------------ profile (BUILD-SPEC 2.2)

    uint256 internal immutable DAY;
    uint256 internal immutable SLICES;
    uint256 internal immutable MIN_READINGS;
    uint256 internal immutable Q_MIN;
    bool internal immutable DEMO_LABEL;
    bool internal immutable SIGN_ALL;
    uint256 internal immutable EPOCH_TS;
    uint256 internal immutable EPOCH_DAY;
    uint64 internal immutable CHAIN_SELECTOR;
    uint256 internal immutable T_PEND;

    Store internal s;

    constructor(InitParams memory p) {
        uint256 day = p.day;
        uint256 slices = p.slices;
        uint256 slice = slices == 0 ? 0 : day / slices;
        uint256 gap = slices / 8 > 1 ? slices / 8 : 1;
        uint256 pendFloor = gap * slice + 60;
        if (
            day == 0 || day > type(uint32).max / 7 || slices == 0 || day % slices != 0 || day % 12 != 0
                || p.minReadings == 0 || p.minReadings > slices || p.qMin == 0 || (p.qMin < 3 && !p.demoLabel)
                || (pendFloor > day / 2 && !p.signAll) || p.epochTs > block.timestamp || p.owner == address(0)
                || p.writers[0] == address(0) || p.attester == address(0) || p.guardians[0] == address(0)
        ) revert BadInit();
        address[6] memory roles = [p.owner, p.writers[0], p.writers[1], p.attester, p.guardians[0], p.guardians[1]];
        for (uint256 i; i < 6; ++i) {
            if (roles[i] == address(0)) continue;
            if (i > 0 && roles[i].code.length != 0) revert BadInit();
            for (uint256 j = i + 1; j < 6; ++j) {
                if (roles[i] == roles[j]) revert BadInit();
            }
        }
        DAY = day;
        SLICES = slices;
        MIN_READINGS = p.minReadings;
        Q_MIN = p.qMin;
        DEMO_LABEL = p.demoLabel;
        SIGN_ALL = p.signAll;
        EPOCH_TS = p.epochTs;
        EPOCH_DAY = p.epochDay;
        CHAIN_SELECTOR = p.chainSelector;
        T_PEND = (p.signAll && pendFloor > day / 2) ? day / 4 : (day / 4 > pendFloor ? day / 4 : pendFloor);
        s.owner = p.owner;
        s.writers = p.writers;
        s.attester = p.attester;
        s.guardians = p.guardians;
        s.forwarder = p.forwarder;
        s.mode = p.writerMode;
    }

    function _prof() internal view returns (Prof memory) {
        return Prof({
            day: DAY,
            slices: SLICES,
            slice: DAY / SLICES,
            minReadings: MIN_READINGS,
            qMin: Q_MIN,
            signAll: SIGN_ALL,
            epochTs: EPOCH_TS,
            epochDay: EPOCH_DAY,
            chainSelector: CHAIN_SELECTOR,
            tPend: T_PEND,
            fullBits: (uint256(1) << SLICES) - 1
        });
    }

    // ------------------------------------------------------------------ writers (4.5)

    function onReport(bytes calldata metadata, bytes calldata report) external override {
        address fwd = s.forwarder;
        if (fwd == address(0) || msg.sender != fwd) revert A1_NotForwarder(msg.sender);
        address w;
        if (s.mode == WriterMode.TX_ORIGIN) {
            w = tx.origin;
        } else {
            if (metadata.length < 62) revert A2_NotActiveWriter(address(0));
            w = address(bytes20(metadata[42:62]));
        }
        _ingest(w, report);
    }

    function postReport(bytes calldata report) external override {
        _ingest(msg.sender, report);
    }

    function _ingest(address w, bytes calldata report) internal {
        if (!s.activeWriter(w)) revert A2_NotActiveWriter(w);
        IndexReports.ingest(s, _prof(), w, report);
    }

    // ------------------------------------------------------------------ days (4.7, 4.9)

    function closeDay(bytes32 gpuId) external override returns (uint32) {
        _known(gpuId);
        return IndexDays.close(s, _prof(), gpuId, msg.sender);
    }

    function carryDay(bytes32 gpuId) external override returns (uint8) {
        _known(gpuId);
        return IndexDays.carry(s, _prof(), gpuId, msg.sender);
    }

    // ------------------------------------------------------------------ second key (4.8)

    function attest(bytes32 gpuId, uint32 day, address writer, bytes32 digest) external override {
        if (!(msg.sender == s.attester && msg.sender != address(0)) && !s.isGuardian(msg.sender)) {
            revert NotAttesterOrGuardian(msg.sender);
        }
        if (msg.sender.code.length != 0) revert HasCode(msg.sender);
        _known(gpuId);
        IndexDays.attest(s, _prof(), gpuId, day, writer, digest, msg.sender);
    }

    function veto(bytes32 gpuId, uint32 day, address source, bytes32 digest) external override {
        _onlyGuardian();
        _known(gpuId);
        IndexDays.veto(s, gpuId, day, source, digest, msg.sender);
    }

    function suspend(address writer) external override {
        _onlyGuardian();
        if (!s.isWriter(writer)) revert NotAWriter(writer);
        s.suspended[writer] = true;
        emit WriterSuspended(writer, msg.sender);
    }

    // ------------------------------------------------------------------ owner (4.11)

    function registerGpu(
        bytes32 gpuId,
        bytes32 recipeHash,
        uint8[] calldata family,
        uint8[] calldata famQ,
        uint32 firstDay,
        uint32 liveAtStartMask
    ) external override {
        _onlyOwner();
        IndexAdmin.register(s, _prof(), gpuId, recipeHash, family, famQ, firstDay, liveAtStartMask);
    }

    function queue(Action calldata a) external override returns (bytes32) {
        _onlyOwner();
        return IndexAdmin.queue(s, _prof(), a);
    }

    function execute(Action calldata a) external override {
        _onlyOwner();
        IndexAdmin.execute(s, _prof(), a);
    }

    function cancel(Action calldata a) external override {
        _onlyOwner();
        IndexAdmin.cancel(s, a);
    }

    // ------------------------------------------------------------------ views (4.12; none reverts)

    function finalFix(bytes32 gpuId, uint32 day)
        external
        view
        override
        returns (bool ok, uint32 value, Status status, uint8 fresh, bool late, bool incomplete)
    {
        RecS storage r = s.recs[gpuId][day];
        if (!r.exists() || !r.isFinal()) return (false, 0, Status.NONE, 0, false, false);
        return (true, r.value, r.status, r.fresh, r.late, r.incomplete);
    }

    function record(bytes32 gpuId, uint32 day)
        external
        view
        override
        returns (bool exists, bool isFinal, Record memory rec)
    {
        RecS storage r = s.recs[gpuId][day];
        if (!r.exists()) return (false, false, rec);
        rec = Record({
            value: r.value,
            status: r.status,
            fresh: r.fresh,
            quorum: r.quorum,
            held: r.held,
            freshMedian: r.freshMedian,
            late: r.late,
            incomplete: r.incomplete,
            changed: r.changed,
            needsSign: r.needsSign,
            dropped: r.dropped,
            source: r.source,
            postedAt: r.postedAt,
            finalAt: r.finalAt,
            attestedAt: r.attestedAt,
            attestedBy: r.attestedBy,
            digest: r.digest
        });
        return (true, r.isFinal(), rec);
    }

    function previewRecord(bytes32 gpuId, uint32 day, address writer)
        external
        view
        override
        returns (bool, RecordDetail memory)
    {
        return IndexViews.previewRecord(s, _prof(), gpuId, day, writer);
    }

    function previewFix(bytes32 gpuId) external view override returns (bool, RecordDetail memory) {
        return IndexViews.previewFix(s, _prof(), gpuId);
    }

    function firstRecordDay(bytes32 gpuId) external view override returns (bool exists, uint32 day) {
        GpuS storage g = s.gpus[gpuId];
        return (g.frExists, g.frDay);
    }

    function head(bytes32 gpuId) external view override returns (uint32) {
        return s.gpus[gpuId].head;
    }

    function gpu(bytes32 gpuId) external view override returns (GpuConfig memory) {
        GpuS storage g = s.gpus[gpuId];
        return GpuConfig(g.recipeHash, g.nSlots, g.nFamilies, g.firstDay, g.registeredAt, g.lastCarryAt, g.head);
    }

    function slotState(bytes32 gpuId, uint8 slot) external view override returns (SlotState memory st) {
        GpuS storage g = s.gpus[gpuId];
        if (slot >= g.nSlots) return st;
        bool pending;
        if (g.head > 0) {
            RecS storage r = s.recs[gpuId][g.head - 1];
            pending = r.exists() && !r.isFinal();
        }
        return IndexMath.unpack(pending ? g.base[slot] : g.last[slot]);
    }

    function slotStates(bytes32 gpuId)
        external
        view
        override
        returns (SlotState[] memory base, SlotState[] memory last)
    {
        GpuS storage g = s.gpus[gpuId];
        uint256 n = g.nSlots;
        base = new SlotState[](n);
        last = new SlotState[](n);
        for (uint256 i; i < n; ++i) {
            base[i] = IndexMath.unpack(g.base[i]);
            last[i] = IndexMath.unpack(g.last[i]);
        }
    }

    function slotWindow(bytes32 gpuId, uint8 slot) external view override returns (uint32, uint32) {
        GpuS storage g = s.gpus[gpuId];
        if (slot >= g.nSlots) return (NEVER, NEVER);
        return (g.liveFrom[slot], g.liveUntil[slot]);
    }

    function familyOf(bytes32 gpuId, uint8 slot) external view override returns (uint8 family, uint8 famQ) {
        GpuS storage g = s.gpus[gpuId];
        if (slot >= g.nSlots) return (0, 0);
        family = g.family[slot];
        famQ = g.famQ[family];
    }

    function readings(bytes32 gpuId, uint32 day, address writer) external view override returns (Readings memory rd) {
        uint256 n = s.gpus[gpuId].nSlots;
        AccS storage a = s.accs[gpuId][day][writer];
        uint256[3] memory pk = a.packed;
        rd.sums = new uint40[](n);
        rd.counts = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            rd.sums[i] = uint40(IndexMath.sum(pk, i));
            rd.counts[i] = uint8(IndexMath.count(pk, i));
        }
        rd.sliceBits = a.sliceBits;
        rd.late = a.late;
        rd.anyValid = a.anyValid;
        rd.lastPostAt = a.lastPostAt;
    }

    function isVoided(bytes32 gpuId, uint32 day, address writer) external view override returns (bool) {
        return s.voided[gpuId][day][writer];
    }

    function reopenedAt(bytes32 gpuId, uint32 day) external view override returns (uint64) {
        return s.reopenedAt[gpuId][day];
    }

    /// The five newest final records are all CARRIED. Records are contiguous from the first one to head - 1.
    function disrupted(bytes32 gpuId) external view override returns (bool) {
        uint256 h = s.gpus[gpuId].head;
        if (h == 0) return false;
        uint256 f = h - 1;
        RecS storage r = s.recs[gpuId][uint32(f)];
        if (!r.exists()) return false;
        if (!r.isFinal()) {
            if (f == 0) return false;
            --f;
        }
        if (f < 4) return false;
        for (uint256 k; k < 5; ++k) {
            if (s.recs[gpuId][uint32(f - k)].status != Status.CARRIED) return false;
        }
        return true;
    }

    function digestOf(
        bytes32 gpuId,
        uint32 day,
        address source,
        uint32[] calldata p,
        Kind[] calldata kinds,
        uint8[] calldata counts,
        SlotState[] calldata post,
        uint32 value
    ) external pure override returns (bytes32) {
        return IndexMath.digest(gpuId, day, source, p, kinds, counts, post, value);
    }

    function owner() external view override returns (address) {
        return s.owner;
    }

    function writers() external view override returns (address[2] memory) {
        return s.writers;
    }

    function attester() external view override returns (address) {
        return s.attester;
    }

    function guardians() external view override returns (address[2] memory) {
        return s.guardians;
    }

    function isSuspended(address writer) external view override returns (bool) {
        return s.suspended[writer];
    }

    function forwarder() external view override returns (address forwarderAddress, WriterMode mode) {
        return (s.forwarder, s.mode);
    }

    function queuedEta(bytes32 id) external view override returns (uint64) {
        return s.queued[id];
    }

    function actionId(Action calldata a) external pure override returns (bytes32) {
        return keccak256(abi.encode(a));
    }

    function clocks() external view override returns (Clocks memory c) {
        uint256 day = DAY;
        c.day = uint32(day);
        c.slice = uint32(day / SLICES);
        c.tPend = uint32(T_PEND);
        c.closeGrace = uint32(day / SLICES);
        c.grace = uint32(day);
        c.holdMove = uint32(7 * day);
        c.holdMin = uint32(3 * day / 4);
        c.step = uint32(day / 6);
        c.reopenWait = uint32(day / 4);
        c.timelock = uint32(2 * day);
        c.slices = uint8(SLICES);
        c.minReadings = uint8(MIN_READINGS);
        c.qMin = uint8(Q_MIN);
        c.demoLabel = DEMO_LABEL;
        c.signAll = SIGN_ALL;
        c.epochTs = uint64(EPOCH_TS);
        c.epochDay = uint32(EPOCH_DAY);
        c.chainSelector = CHAIN_SELECTOR;
    }

    function dayId(uint64 t) external view override returns (uint32) {
        uint256 d = IndexLib.dayId(_prof(), t);
        return d > type(uint32).max ? type(uint32).max : uint32(d);
    }

    function dayStart(uint32 day) external view override returns (uint64) {
        if (day < EPOCH_DAY) return uint64(EPOCH_TS);
        uint256 t = IndexLib.dayStart(_prof(), day);
        return t > type(uint64).max ? type(uint64).max : uint64(t);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ------------------------------------------------------------------ internals

    function _onlyOwner() internal view {
        if (msg.sender != s.owner) revert NotOwner(msg.sender);
    }

    function _onlyGuardian() internal view {
        if (!s.isGuardian(msg.sender)) revert NotGuardian(msg.sender);
        if (msg.sender.code.length != 0) revert HasCode(msg.sender);
    }

    function _known(bytes32 id) internal view {
        if (s.gpus[id].nSlots == 0) revert UnknownGpu(id);
    }
}
