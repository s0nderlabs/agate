// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateIndex, MAX_SLOTS, HOLD_DAYS, NEVER} from "../interfaces/IAgateIndex.sol";
import {Store, GpuS, Prof} from "./IndexTypes.sol";
import {DateLib} from "./DateLib.sol";
import {IndexLib} from "./IndexLib.sol";

/// @title IndexAdmin: the owner's registerGpu and 48 h queue (BUILD-SPEC 4.11). A linked library.
library IndexAdmin {
    function register(
        Store storage s,
        Prof memory pf,
        bytes32 id,
        bytes32 recipeHash,
        uint8[] calldata family,
        uint8[] calldata famQ,
        uint32 firstDay,
        uint32 liveAtStartMask
    ) external {
        GpuS storage g = s.gpus[id];
        if (id == bytes32(0) || g.nSlots != 0) revert IAgateIndex.GpuExists(id);
        uint256 n = family.length;
        if (n == 0 || n > MAX_SLOTS || liveAtStartMask >> n != 0) revert IAgateIndex.BadSlots();
        uint256 nF = famQ.length;
        // fewer families than Q_MIN could never close a day, and registration is append-only: refused
        if (nF == 0 || nF > n || nF < pf.qMin) revert IAgateIndex.BadFamilies();
        uint256[15] memory members;
        for (uint256 i; i < n; ++i) {
            if (family[i] >= nF) revert IAgateIndex.BadFamilies();
            ++members[family[i]];
        }
        // famQ above the family's slot count would make that family never count: refused as well
        for (uint256 f; f < nF; ++f) {
            if (members[f] == 0 || famQ[f] == 0 || famQ[f] > members[f]) revert IAgateIndex.BadFamilies();
        }
        uint256 today = IndexLib.dayId(pf, block.timestamp);
        if (firstDay < pf.epochDay || uint256(firstDay) + 31 < today || firstDay > today + 31) {
            revert IAgateIndex.FirstDayOutOfRange(firstDay);
        }
        if (liveAtStartMask == 0) revert IAgateIndex.NothingLive();
        g.recipeHash = recipeHash;
        g.nSlots = uint8(n);
        g.nFamilies = uint8(nF);
        g.firstDay = firstDay;
        g.registeredAt = uint64(block.timestamp);
        g.lastCarryAt = uint64(block.timestamp);
        g.head = firstDay;
        uint64[15] memory init;
        uint32[15] memory from;
        uint32[15] memory until;
        uint8[15] memory fam;
        uint8[15] memory q;
        for (uint256 i; i < 15; ++i) {
            from[i] = i < n && (liveAtStartMask >> i) & 1 == 1 ? firstDay : NEVER;
            until[i] = NEVER;
            if (i < n) {
                init[i] = uint64(HOLD_DAYS + 1) << 32;
                fam[i] = family[i];
            }
            if (i < nF) q[i] = famQ[i];
        }
        g.family = fam;
        g.famQ = q;
        g.liveFrom = from;
        g.liveUntil = until;
        g.base = init;
        g.last = init;
        emit IAgateIndex.GpuRegistered(id, recipeHash, firstDay, family, famQ, liveAtStartMask);
    }

    function queue(Store storage s, Prof memory pf, IAgateIndex.Action calldata a) external returns (bytes32 id) {
        _validate(s, pf, a, true);
        id = keccak256(abi.encode(a));
        if (s.queued[id] != 0) revert IAgateIndex.AlreadyQueued(id);
        uint64 eta = uint64(block.timestamp + 2 * pf.day);
        s.queued[id] = eta;
        emit IAgateIndex.ActionQueued(id, a, eta);
    }

    function execute(Store storage s, Prof memory pf, IAgateIndex.Action calldata a) external {
        bytes32 id = keccak256(abi.encode(a));
        uint64 eta = s.queued[id];
        if (eta == 0) revert IAgateIndex.NotQueued(id);
        if (block.timestamp < eta) revert IAgateIndex.TimelockActive(eta);
        _validate(s, pf, a, false);
        delete s.queued[id];
        IAgateIndex.ActionKind k = a.kind;
        if (k == IAgateIndex.ActionKind.WRITER) {
            s.writers[a.slot] = a.addr;
            s.suspended[a.addr] = false;
        } else if (k == IAgateIndex.ActionKind.ATTESTER) {
            s.attester = a.addr;
        } else if (k == IAgateIndex.ActionKind.GUARDIAN) {
            s.guardians[a.slot] = a.addr;
        } else if (k == IAgateIndex.ActionKind.FORWARDER) {
            s.forwarder = a.addr;
            s.mode = a.mode;
        } else if (k == IAgateIndex.ActionKind.LIVE_FROM) {
            s.gpus[a.gpuId].liveFrom[a.slot] = a.day;
        } else if (k == IAgateIndex.ActionKind.LIVE_UNTIL) {
            s.gpus[a.gpuId].liveUntil[a.slot] = a.day;
        } else {
            s.owner = a.addr;
        }
        emit IAgateIndex.ActionExecuted(id, a);
    }

    function cancel(Store storage s, IAgateIndex.Action calldata a) external {
        bytes32 id = keccak256(abi.encode(a));
        if (s.queued[id] == 0) revert IAgateIndex.NotQueued(id);
        delete s.queued[id];
        emit IAgateIndex.ActionCancelled(id);
    }

    /// The checks of 4.11's table; fields an action kind does not use must be zero (BadAction), so one effect has
    /// one id.
    function _validate(Store storage s, Prof memory pf, IAgateIndex.Action calldata a, bool atQueue) private view {
        IAgateIndex.ActionKind k = a.kind;
        bool usesGpu = k == IAgateIndex.ActionKind.LIVE_FROM || k == IAgateIndex.ActionKind.LIVE_UNTIL;
        bool usesSlot = usesGpu || k == IAgateIndex.ActionKind.WRITER || k == IAgateIndex.ActionKind.GUARDIAN;
        if (
            (!usesSlot && a.slot != 0) || (usesGpu && a.addr != address(0))
                || (!usesGpu && (a.gpuId != bytes32(0) || a.day != 0))
                || (k != IAgateIndex.ActionKind.FORWARDER && a.mode != IAgateIndex.WriterMode.TX_ORIGIN)
        ) revert IAgateIndex.BadAction();
        if (k == IAgateIndex.ActionKind.WRITER || k == IAgateIndex.ActionKind.GUARDIAN) {
            if (a.slot >= 2) revert IAgateIndex.BadSlot(a.slot);
            if (!atQueue) _checkAppointee(s, a.addr, k, a.slot);
        } else if (k == IAgateIndex.ActionKind.ATTESTER) {
            if (!atQueue) _checkAppointee(s, a.addr, k, 0);
        } else if (k == IAgateIndex.ActionKind.OWNER) {
            if (a.addr == address(0)) revert IAgateIndex.ZeroAddress();
            _checkAppointee(s, a.addr, k, 0);
        } else if (usesGpu) {
            GpuS storage g = s.gpus[a.gpuId];
            if (g.nSlots == 0) revert IAgateIndex.UnknownGpu(a.gpuId);
            if (a.slot >= g.nSlots) revert IAgateIndex.BadSlot(a.slot);
            uint256 today = IndexLib.dayId(pf, block.timestamp);
            if (k == IAgateIndex.ActionKind.LIVE_FROM) {
                if (g.liveFrom[a.slot] != NEVER) revert IAgateIndex.SlotAlreadyStarted(a.slot);
                if (!DateLib.isFirstOfMonth(a.day)) revert IAgateIndex.LiveFromNotFirstOfMonth(a.day);
                if (atQueue) {
                    uint256 m = DateLib.monthOf(a.day);
                    if (m <= 1970 * 12 || today >= DateLib.firstDayOf(m - 1)) {
                        revert IAgateIndex.LiveFromTooLate(a.day);
                    }
                }
            } else {
                if (g.liveFrom[a.slot] == NEVER || g.liveUntil[a.slot] != NEVER) {
                    revert IAgateIndex.SlotWindowNotOpen(a.slot);
                }
                if (atQueue && a.day < IndexLib.dayId(pf, block.timestamp + 2 * pf.day) + 1) {
                    revert IAgateIndex.LiveUntilTooEarly(a.day);
                }
            }
            if (!atQueue && a.day <= today) revert IAgateIndex.DayBegun(a.day);
        }
    }

    /// One address, one role (its own seat excepted); every role holder but the owner has no code.
    function _checkAppointee(Store storage s, address addr, IAgateIndex.ActionKind k, uint8 slot) private view {
        if (addr == address(0)) return;
        bool w = k == IAgateIndex.ActionKind.WRITER;
        bool gd = k == IAgateIndex.ActionKind.GUARDIAN;
        if (
            (addr == s.owner && k != IAgateIndex.ActionKind.OWNER)
                || (addr == s.attester && k != IAgateIndex.ActionKind.ATTESTER)
                || (addr == s.writers[0] && !(w && slot == 0)) || (addr == s.writers[1] && !(w && slot == 1))
                || (addr == s.guardians[0] && !(gd && slot == 0)) || (addr == s.guardians[1] && !(gd && slot == 1))
        ) revert IAgateIndex.RoleTaken(addr);
        if (k != IAgateIndex.ActionKind.OWNER && addr.code.length != 0) revert IAgateIndex.HasCode(addr);
    }
}
