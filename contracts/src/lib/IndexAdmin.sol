// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgateIndex, MAX_SLOTS, HOLD_DAYS, NEVER, ACTION_WINDOW_DAYS, READER_SWAP_TAG
} from "../interfaces/IAgateIndex.sol";
import {Store, GpuS, Prof} from "./IndexTypes.sol";
import {DateLib} from "./DateLib.sol";
import {IndexLib} from "./IndexLib.sol";

/// @title IndexAdmin: the owner's registerGpu, 48 h queue with its 14 DAY execute window (BUILD-SPEC 4.11) and reader
/// swap (4.15). A linked library.
library IndexAdmin {
    // reader swap bounds (4.15), in bytes
    uint256 internal constant URL_MIN = 9;
    uint256 internal constant URL_MAX = 256;
    uint256 internal constant PARSER_MAX = 32;
    uint256 internal constant REASON_MAX = 280;

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
        uint64 eta = enqueue(s, pf, id);
        emit IAgateIndex.ActionQueued(id, a, eta);
    }

    function execute(Store storage s, Prof memory pf, IAgateIndex.Action calldata a) external {
        bytes32 id = keccak256(abi.encode(a));
        checkExecutable(s, pf, id);
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

    /// An expired entry can still be cancelled (log hygiene).
    function cancel(Store storage s, IAgateIndex.Action calldata a) external {
        bytes32 id = keccak256(abi.encode(a));
        if (s.queued[id] == 0) revert IAgateIndex.NotQueued(id);
        delete s.queued[id];
        emit IAgateIndex.ActionCancelled(id);
    }

    // ------------------------------------------------------------------ the queue (actions and reader swaps, 4.11)

    /// The last second an entry queued with this eta can execute (the deadline itself still executes).
    function deadlineOf(Prof memory pf, uint256 eta) internal pure returns (uint256) {
        return eta + ACTION_WINDOW_DAYS * pf.day;
    }

    /// The eta a view shows: 0 when nothing live is queued (none, or past its window).
    function liveEta(Store storage s, Prof memory pf, bytes32 id) internal view returns (uint64 eta) {
        eta = s.queued[id];
        if (eta != 0 && block.timestamp > deadlineOf(pf, eta)) eta = 0;
    }

    /// Queues id at now + TIMELOCK. A live entry is refused; one past its window is dead and is queued afresh.
    function enqueue(Store storage s, Prof memory pf, bytes32 id) internal returns (uint64 eta) {
        uint64 old = s.queued[id];
        if (old != 0 && block.timestamp <= deadlineOf(pf, old)) revert IAgateIndex.AlreadyQueued(id);
        eta = uint64(block.timestamp + 2 * pf.day);
        s.queued[id] = eta;
    }

    /// Queued, the timelock over, the window not yet over.
    function checkExecutable(Store storage s, Prof memory pf, bytes32 id) internal view {
        uint64 eta = s.queued[id];
        if (eta == 0) revert IAgateIndex.NotQueued(id);
        if (block.timestamp < eta) revert IAgateIndex.TimelockActive(eta);
        uint256 deadline = deadlineOf(pf, eta);
        if (block.timestamp > deadline) revert IAgateIndex.ActionExpired(id, uint64(deadline));
    }

    // ------------------------------------------------------------------ reader swap (4.15)
    // A swap changes which page a slot's readers fetch and how they parse it, from a next day start. It shares the
    // queue, TIMELOCK and execute window of the actions, and no formula path reads anything stored here (I31).

    function queueSwap(
        Store storage s,
        Prof memory pf,
        bytes32 gpuId,
        uint8 slot,
        IAgateIndex.Reader calldata r,
        string calldata reason
    ) external returns (bytes32 id) {
        _check(s, gpuId, slot, r);
        uint256 nr = bytes(reason).length;
        if (nr == 0 || nr > REASON_MAX) revert IAgateIndex.BadReader();
        // printable ASCII only (queue only: the id binds url and parserVersion): no terminal escapes reach a reader
        _printable(bytes(r.url), 0x21);
        _printable(bytes(r.parserVersion), 0x21);
        _printable(bytes(reason), 0x20);
        id = swapId(gpuId, slot, r);
        uint64 eta = enqueue(s, pf, id);
        s.readerReason[id] = reason;
        emit IAgateIndex.ReaderSwapQueued(id, gpuId, slot, r.url, r.parserVersion, reason, eta);
    }

    function executeSwap(Store storage s, Prof memory pf, bytes32 gpuId, uint8 slot, IAgateIndex.Reader calldata r)
        external
    {
        bytes32 id = swapId(gpuId, slot, r);
        checkExecutable(s, pf, id);
        _check(s, gpuId, slot, r);
        // the next day start with at least one slice of notice: inside a day's last slice, the day after
        uint256 fromDay = IndexLib.dayId(pf, block.timestamp + pf.slice) + 1;
        IAgateIndex.ReaderVersion[] storage h = s.readers[gpuId][slot];
        uint256 n = h.length;
        if (n != 0 && h[n - 1].fromDay >= fromDay) {
            revert IAgateIndex.ReaderSwapPending(gpuId, slot, h[n - 1].fromDay);
        }
        string memory reason = s.readerReason[id];
        bytes32 rh = readerHash(r);
        h.push(
            IAgateIndex.ReaderVersion(uint32(fromDay), uint64(block.timestamp), rh, r.url, r.parserVersion, reason)
        );
        delete s.queued[id];
        delete s.readerReason[id];
        emit IAgateIndex.ReaderSwapped(id, gpuId, slot, uint32(fromDay), rh, r.url, r.parserVersion, reason);
    }

    /// Live or expired.
    function cancelSwap(Store storage s, bytes32 gpuId, uint8 slot, IAgateIndex.Reader calldata r) external {
        bytes32 id = swapId(gpuId, slot, r);
        if (s.queued[id] == 0) revert IAgateIndex.NotQueued(id);
        delete s.queued[id];
        delete s.readerReason[id];
        emit IAgateIndex.ReaderSwapCancelled(id, gpuId, slot);
    }

    function history(Store storage s, bytes32 gpuId, uint8 slot)
        external
        view
        returns (IAgateIndex.ReaderVersion[] memory)
    {
        return s.readers[gpuId][slot];
    }

    /// The newest swap with fromDay <= day (fromDay strictly increases along the history).
    function at(Store storage s, bytes32 gpuId, uint8 slot, uint32 day)
        external
        view
        returns (bool swapped, IAgateIndex.ReaderVersion memory v)
    {
        IAgateIndex.ReaderVersion[] storage h = s.readers[gpuId][slot];
        for (uint256 i = h.length; i > 0; --i) {
            if (h[i - 1].fromDay <= day) return (true, h[i - 1]);
        }
    }

    function readerHash(IAgateIndex.Reader calldata r) internal pure returns (bytes32) {
        return keccak256(abi.encode(r.url, r.parserVersion));
    }

    function swapId(bytes32 gpuId, uint8 slot, IAgateIndex.Reader calldata r) internal pure returns (bytes32) {
        return keccak256(abi.encode(READER_SWAP_TAG, gpuId, slot, readerHash(r)));
    }

    /// A registered gpu, a slot below nSlots, an https url of 9 to 256 bytes and a parserVersion of 1 to 32 bytes.
    function _check(Store storage s, bytes32 gpuId, uint8 slot, IAgateIndex.Reader calldata r) private view {
        uint256 n = s.gpus[gpuId].nSlots;
        if (n == 0) revert IAgateIndex.UnknownGpu(gpuId);
        if (slot >= n) revert IAgateIndex.BadSlot(slot);
        bytes calldata u = bytes(r.url);
        uint256 np = bytes(r.parserVersion).length;
        if (
            u.length < URL_MIN || u.length > URL_MAX || bytes8(u[:8]) != bytes8("https://") || np == 0
                || np > PARSER_MAX
        ) revert IAgateIndex.BadReader();
    }

    /// Every byte in [lo, 0x7e]: no C0 control, no DEL, no byte of 0x80 or more (so no C1 control either).
    function _printable(bytes calldata b, uint8 lo) private pure {
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < lo || c > 0x7e) revert IAgateIndex.BadReader();
        }
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
