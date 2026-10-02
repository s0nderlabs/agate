// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";

/// @notice BUILD-SPEC A.9: the IAgateIndex views a series and a factory read (finalFix, record, firstRecordDay, gpu,
/// clocks, dayId, dayStart), with the wall's signatures and semantics, over records the test sets directly. Every
/// other IAgateIndex function reverts NotImplemented. No call counter (finalFix and record are view): count index
/// calls with vm.expectCall(address(index), abi.encodeWithSelector(IAgateIndex.finalFix.selector), n).
contract MockIndex is IAgateIndex {
    error NotImplemented();
    error StatusNone(); // put needs a real status: a record exists iff its status is not NONE, as in the wall
    error IndexDown(bytes32 gpuId, uint32 day); // the revert mode of setRevertFrom

    struct Rec {
        uint32 value;
        Status status;
        uint8 fresh;
        bool late;
        bool incomplete;
        uint64 finalAt;
    }

    uint32 internal immutable DAY;
    uint64 internal immutable EPOCH_TS;
    uint32 internal immutable EPOCH_DAY;

    mapping(bytes32 => mapping(uint32 => Rec)) internal recs;
    mapping(bytes32 => bytes32) internal recipe;
    mapping(bytes32 => uint64) internal registeredAt;
    mapping(bytes32 => uint32[]) internal recDays; // the days with a record, unordered
    mapping(bytes32 => mapping(uint32 => uint256)) internal recPos; // 1-based index in recDays; 0 = no record
    mapping(bytes32 => bool) internal hasFirst;
    mapping(bytes32 => uint32) internal first;
    mapping(bytes32 => uint64) internal revertFromPlus1; // 0 = off; else finalFix reverts for days >= value - 1
    uint256 public burn; // gas finalFix burns first

    constructor(uint32 day, uint64 epochTs, uint32 epochDay) {
        if (day == 0) revert BadInit();
        DAY = day;
        EPOCH_TS = epochTs;
        EPOCH_DAY = epochDay;
    }

    // ------------------------------------------------------------------ test setters

    function register(bytes32 gpuId, bytes32 recipeHash) external {
        recipe[gpuId] = recipeHash;
        registeredAt[gpuId] = uint64(block.timestamp);
    }

    /// Sets (or replaces) the record of day. finalAt 0: never final; final once block.timestamp >= finalAt.
    function put(
        bytes32 gpuId,
        uint32 day,
        uint32 value,
        uint64 finalAt,
        Status status,
        uint8 fresh,
        bool late,
        bool incomplete
    ) external {
        if (status == Status.NONE) revert StatusNone();
        recs[gpuId][day] = Rec(value, status, fresh, late, incomplete, finalAt);
        if (recPos[gpuId][day] == 0) {
            recDays[gpuId].push(day);
            recPos[gpuId][day] = recDays[gpuId].length;
        }
        if (!hasFirst[gpuId] || day < first[gpuId]) {
            hasFirst[gpuId] = true;
            first[gpuId] = day;
        }
    }

    /// Deletes the record of day (a veto or a drop); deleting the lowest moves firstRecordDay to the next one.
    function del(bytes32 gpuId, uint32 day) external {
        uint256 pos = recPos[gpuId][day];
        if (pos == 0) return;
        delete recs[gpuId][day];
        uint32[] storage ds = recDays[gpuId];
        uint32 moved = ds[ds.length - 1];
        ds[pos - 1] = moved;
        recPos[gpuId][moved] = pos;
        ds.pop();
        delete recPos[gpuId][day];
        if (first[gpuId] != day) return;
        if (ds.length == 0) {
            hasFirst[gpuId] = false;
            first[gpuId] = 0;
            return;
        }
        uint32 lowest = ds[0];
        for (uint256 i = 1; i < ds.length; ++i) {
            if (ds[i] < lowest) lowest = ds[i];
        }
        first[gpuId] = lowest;
    }

    /// finalFix reverts for every day >= day; type(uint32).max = off; 0 = every day.
    function setRevertFrom(bytes32 gpuId, uint32 day) external {
        revertFromPlus1[gpuId] = day == type(uint32).max ? 0 : uint64(day) + 1;
    }

    function setBurn(uint256 gas) external {
        burn = gas;
    }

    // ------------------------------------------------------------------ the views a series and a factory read

    function finalFix(bytes32 gpuId, uint32 day)
        external
        view
        override
        returns (bool ok, uint32 value, Status status, uint8 fresh, bool late, bool incomplete)
    {
        uint256 b = burn;
        if (b != 0) {
            uint256 g = gasleft();
            uint256 stop = g > b ? g - b : 0;
            while (gasleft() > stop) {}
        }
        uint64 rf = revertFromPlus1[gpuId];
        if (rf != 0 && day >= rf - 1) revert IndexDown(gpuId, day);
        Rec storage r = recs[gpuId][day];
        if (r.status == Status.NONE || !_isFinal(r)) return (false, 0, Status.NONE, 0, false, false);
        return (true, r.value, r.status, r.fresh, r.late, r.incomplete);
    }

    function record(bytes32 gpuId, uint32 day)
        external
        view
        override
        returns (bool exists, bool isFinal, Record memory rec)
    {
        Rec storage r = recs[gpuId][day];
        if (r.status == Status.NONE) return (false, false, rec);
        rec.value = r.value;
        rec.status = r.status;
        rec.fresh = r.fresh;
        rec.late = r.late;
        rec.incomplete = r.incomplete;
        rec.finalAt = r.finalAt;
        return (true, _isFinal(r), rec);
    }

    function firstRecordDay(bytes32 gpuId) external view override returns (bool exists, uint32 day) {
        return (hasFirst[gpuId], first[gpuId]);
    }

    /// Only recipeHash and registeredAt are set.
    function gpu(bytes32 gpuId) external view override returns (GpuConfig memory g) {
        g.recipeHash = recipe[gpuId];
        g.registeredAt = registeredAt[gpuId];
    }

    /// Only day, epochTs and epochDay are set.
    function clocks() external view override returns (Clocks memory c) {
        c.day = DAY;
        c.epochTs = EPOCH_TS;
        c.epochDay = EPOCH_DAY;
    }

    function dayId(uint64 t) external view override returns (uint32) {
        uint256 d = t < EPOCH_TS ? EPOCH_DAY : uint256(EPOCH_DAY) + (t - EPOCH_TS) / DAY;
        return d > type(uint32).max ? type(uint32).max : uint32(d);
    }

    function dayStart(uint32 day) external view override returns (uint64) {
        if (day < EPOCH_DAY) return EPOCH_TS;
        uint256 t = uint256(EPOCH_TS) + uint256(day - EPOCH_DAY) * DAY;
        return t > type(uint64).max ? type(uint64).max : uint64(t);
    }

    function _isFinal(Rec storage r) internal view returns (bool) {
        return r.finalAt != 0 && block.timestamp >= r.finalAt;
    }

    // ------------------------------------------------------------------ everything else: not used by the market

    function onReport(bytes calldata, bytes calldata) external pure override {
        revert NotImplemented();
    }

    function supportsInterface(bytes4) external pure override returns (bool) {
        revert NotImplemented();
    }

    function postReport(bytes calldata) external pure override {
        revert NotImplemented();
    }

    function closeDay(bytes32) external pure override returns (uint32) {
        revert NotImplemented();
    }

    function carryDay(bytes32) external pure override returns (uint8) {
        revert NotImplemented();
    }

    function attest(bytes32, uint32, address, bytes32) external pure override {
        revert NotImplemented();
    }

    function veto(bytes32, uint32, address, bytes32) external pure override {
        revert NotImplemented();
    }

    function suspend(address) external pure override {
        revert NotImplemented();
    }

    function registerGpu(bytes32, bytes32, uint8[] calldata, uint8[] calldata, uint32, uint32)
        external
        pure
        override
    {
        revert NotImplemented();
    }

    function queue(Action calldata) external pure override returns (bytes32) {
        revert NotImplemented();
    }

    function execute(Action calldata) external pure override {
        revert NotImplemented();
    }

    function cancel(Action calldata) external pure override {
        revert NotImplemented();
    }

    function previewRecord(bytes32, uint32, address) external pure override returns (bool, RecordDetail memory) {
        revert NotImplemented();
    }

    function previewFix(bytes32) external pure override returns (bool, RecordDetail memory) {
        revert NotImplemented();
    }

    function head(bytes32) external pure override returns (uint32) {
        revert NotImplemented();
    }

    function slotState(bytes32, uint8) external pure override returns (SlotState memory) {
        revert NotImplemented();
    }

    function slotStates(bytes32) external pure override returns (SlotState[] memory, SlotState[] memory) {
        revert NotImplemented();
    }

    function slotWindow(bytes32, uint8) external pure override returns (uint32, uint32) {
        revert NotImplemented();
    }

    function familyOf(bytes32, uint8) external pure override returns (uint8, uint8) {
        revert NotImplemented();
    }

    function readings(bytes32, uint32, address) external pure override returns (Readings memory) {
        revert NotImplemented();
    }

    function isVoided(bytes32, uint32, address) external pure override returns (bool) {
        revert NotImplemented();
    }

    function reopenedAt(bytes32, uint32) external pure override returns (uint64) {
        revert NotImplemented();
    }

    function disrupted(bytes32) external pure override returns (bool) {
        revert NotImplemented();
    }

    function digestOf(
        bytes32,
        uint32,
        address,
        uint32[] calldata,
        Kind[] calldata,
        uint8[] calldata,
        SlotState[] calldata,
        uint32
    ) external pure override returns (bytes32) {
        revert NotImplemented();
    }

    function owner() external pure override returns (address) {
        revert NotImplemented();
    }

    function writers() external pure override returns (address[2] memory) {
        revert NotImplemented();
    }

    function attester() external pure override returns (address) {
        revert NotImplemented();
    }

    function guardians() external pure override returns (address[2] memory) {
        revert NotImplemented();
    }

    function isSuspended(address) external pure override returns (bool) {
        revert NotImplemented();
    }

    function forwarder() external pure override returns (address, WriterMode) {
        revert NotImplemented();
    }

    function queuedEta(bytes32) external pure override returns (uint64) {
        revert NotImplemented();
    }

    function actionId(Action calldata) external pure override returns (bytes32) {
        revert NotImplemented();
    }
}
