// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {AgateSeries} from "../../../src/market/AgateSeries.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {IAgateToken} from "../../../src/market/interfaces/IAgateToken.sol";
import {Side, BandGrade, SeriesTerms, Position} from "../../../src/market/MarketTypes.sol";
import {MockIndex} from "../mocks/MockIndex.sol";
import {TestDollar} from "../series/SeriesBase.sol";

/// Replays a vector of docs/market/model/gen_vectors.py (format in its docstring) call by call on a fresh MockIndex,
/// test dollar and series: every call must succeed or revert as in the model (with the model's error), return the
/// model's numbers, leave the model's state and emit the model's FixApplied events; the balances and positions at the
/// end must be the model's. Returns a digest of every result and state, independent of the clock (I35).
abstract contract SeriesReplay is Test {
    bytes32 internal constant GPU = keccak256("H100-SXM/on-demand-list/neocloud/v1");
    bytes32 internal constant FIX_APPLIED = keccak256("FixApplied(uint8,uint32,uint32,uint32,uint8,uint8,uint64)");
    uint256 internal constant OP_W = 12;
    uint256 internal constant STATE_W = 6;
    uint256 internal constant FIX_W = 8;
    uint256 internal constant POS_W = 8;
    uint256 internal constant OTHER = 17;
    address internal constant ROUTER = address(uint160(uint256(keccak256("agate.replay.router"))));
    address internal constant FACTORY = address(uint160(uint256(keccak256("agate.replay.factory"))));

    struct Ctx {
        string name;
        MockIndex index;
        TestDollar dollar;
        AgateSeries s;
        IAgateToken tok;
        uint256[] ops;
        uint256[] ids;
        uint256[] states;
        uint256[] fixes;
        uint256 nFixes;
        uint256 fixAt;
        uint256 op;
        bytes32 digest;
    }

    function _path(string memory name) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/market/vectors/", name, ".json");
    }

    function _addr(Ctx memory c, uint256 i) internal pure returns (address) {
        if (i < 100) return vm.addr(uint256(keccak256(abi.encode("agate.replay.actor", i))));
        if (i == 100) return address(0);
        if (i == 101) return address(c.s);
        if (i == 102) return address(c.tok);
        if (i == 103) return ROUTER;
        return FACTORY;
    }

    function _at(Ctx memory c, string memory what) internal pure returns (string memory) {
        return string.concat(c.name, " op ", vm.toString(c.op), ": ", what);
    }

    function _eq(Ctx memory c, uint256 got, uint256 want, string memory what) internal pure {
        if (got != want) {
            revert(string.concat(_at(c, what), ": got ", vm.toString(got), ", model ", vm.toString(want)));
        }
    }

    function _errSel(uint256 e) internal pure returns (bytes4) {
        bytes4[17] memory sels = [
            bytes4(0),
            IAgateSeries.BadAmount.selector,
            IAgateSeries.BadRecipient.selector,
            IAgateSeries.BadOwner.selector,
            IAgateSeries.BadPayee.selector,
            IAgateSeries.BadOperator.selector,
            IAgateSeries.TokenBalance.selector,
            IAgateSeries.ShortBalance.selector,
            IAgateSeries.MonthFinal.selector,
            IAgateSeries.MonthNotFinal.selector,
            IAgateSeries.NoPosition.selector,
            IAgateSeries.NotOwner.selector,
            IAgateSeries.NotOwnerOrOperator.selector,
            IAgateSeries.OperatorMustPayOwner.selector,
            IAgateSeries.SyncGasLow.selector,
            IAgateSeries.DollarInexact.selector,
            bytes4(0x4e487b71) // Panic(0x11): the ledger cannot pay
        ];
        return sels[e];
    }

    // ------------------------------------------------------------------ setup from the vector

    function _setUp(Ctx memory c, string memory json) internal {
        uint256[] memory clock = vm.parseJsonUintArray(json, ".clock");
        c.index = new MockIndex(uint32(clock[0]), uint64(clock[1]), uint32(clock[2]));
        c.index.register(GPU, bytes32(0));
        uint256[] memory rec = vm.parseJsonUintArray(json, ".records");
        for (uint256 i; i + 7 <= rec.length; i += 7) {
            c.index.put(
                GPU,
                uint32(rec[i]),
                uint32(rec[i + 1]),
                uint64(rec[i + 2]),
                IAgateIndex.Status(rec[i + 3]),
                uint8(rec[i + 4]),
                rec[i + 5] == 1,
                rec[i + 6] == 1
            );
        }
        c.index.setRevertFrom(GPU, uint32(vm.parseJsonUint(json, ".revertFrom")));
        c.dollar = new TestDollar();
        uint256[] memory t = vm.parseJsonUintArray(json, ".terms");
        SeriesTerms memory terms = SeriesTerms({
            index: address(c.index),
            dollar: address(c.dollar),
            factory: FACTORY,
            router: ROUTER,
            gpuId: GPU,
            recipeHash: bytes32(0),
            month: uint32(t[0]),
            startDay: uint32(t[1]),
            n: uint8(t[2]),
            startTs: uint64(t[3]),
            day: uint32(t[4]),
            lastResort: uint64(t[5]),
            floor: uint32(t[6]),
            cap: uint32(t[7]),
            x0: uint32(t[8]),
            bandGrade: BandGrade(t[9]),
            anchorCarried: uint8(t[10]),
            anchorMinFresh: uint8(t[11]),
            anchorLate: t[12] == 1
        });
        c.s = _newSeries(terms);
        c.tok = IAgateToken(c.s.token());
        uint256[] memory holders = vm.parseJsonUintArray(json, ".holders");
        uint256[] memory dollars0 = vm.parseJsonUintArray(json, ".dollars0");
        for (uint256 i; i < holders.length; ++i) {
            address h = _addr(c, holders[i]);
            c.dollar.mint(h, dollars0[i]);
            vm.prank(h);
            c.dollar.approve(address(c.s), type(uint256).max);
        }
        c.ops = vm.parseJsonUintArray(json, ".ops");
        c.ids = vm.parseJsonUintArray(json, ".ids");
        c.states = vm.parseJsonUintArray(json, ".states");
        c.fixes = vm.parseJsonUintArray(json, ".fixes");
        c.nFixes = vm.parseJsonUint(json, ".nFixes");
    }

    /// The series under test; a control overrides it with a broken one.
    function _newSeries(SeriesTerms memory terms) internal virtual returns (AgateSeries) {
        return new AgateSeries(terms, "agate replay", "REPLAY");
    }

    // ------------------------------------------------------------------ one call

    function _calldata(Ctx memory c, uint256 b) internal pure returns (address target, bytes memory data, bool view_) {
        uint256[] memory o = c.ops;
        uint256 code = o[b];
        target = address(c.s);
        if (code == 0) {
            data = abi.encodeCall(IAgateSeries.mint, (o[b + 3], _addr(c, o[b + 4])));
        } else if (code == 1) {
            data = abi.encodeCall(IAgateSeries.redeem, (o[b + 3], _addr(c, o[b + 4])));
        } else if (code == 2) {
            data = abi.encodeCall(
                IAgateSeries.streamOut,
                (Side(o[b + 3]), o[b + 4], _addr(c, o[b + 5]), _addr(c, o[b + 6]), _addr(c, o[b + 7]), o[b + 8] == 1)
            );
        } else if (code == 3) {
            data = abi.encodeCall(IAgateSeries.claim, (o[b + 3]));
        } else if (code == 4) {
            uint256[] memory list = new uint256[](o[b + 4]);
            for (uint256 i; i < list.length; ++i) {
                list[i] = c.ids[o[b + 3] + i];
            }
            data = abi.encodeCall(IAgateSeries.claimMany, (list));
        } else if (code == 5) {
            data = abi.encodeCall(IAgateSeries.setPayout, (o[b + 3], _addr(c, o[b + 4]), o[b + 5] == 1));
        } else if (code == 6) {
            data = abi.encodeCall(IAgateSeries.setOperator, (o[b + 3], _addr(c, o[b + 4])));
        } else if (code == 7) {
            data = abi.encodeCall(IAgateSeries.closeWithToken, (o[b + 3], _addr(c, o[b + 4])));
        } else if (code == 8) {
            data = abi.encodeCall(IAgateSeries.unstream, (o[b + 3], _addr(c, o[b + 4])));
        } else if (code == 9) {
            data = abi.encodeCall(IAgateSeries.settle, (Side(o[b + 3]), o[b + 4], _addr(c, o[b + 5])));
        } else if (code == 10) {
            data = abi.encodeCall(IAgateSeries.sync, (o[b + 3]));
        } else if (code == 11) {
            target = address(c.tok);
            data = abi.encodeWithSignature("transfer(address,uint256)", _addr(c, o[b + 3]), o[b + 4]);
        } else if (code == 12) {
            target = address(c.dollar);
            data = abi.encodeWithSignature("transfer(address,uint256)", address(c.s), o[b + 3]);
        } else if (code == 13) {
            target = address(c.tok);
            data = abi.encodeWithSignature("transfer(address,uint256)", address(c.s), o[b + 3]);
        } else if (code == 14) {
            (data, view_) = (abi.encodeCall(IAgateSeries.claimable, (o[b + 3])), true);
        } else if (code == 15) {
            (data, view_) = (abi.encodeCall(IAgateSeries.previewSync, ()), true);
        } else if (code == 16) {
            (data, view_) = (abi.encodeCall(IAgateSeries.owed, (Side(o[b + 3]), o[b + 4])), true);
        } else {
            revert(_at(c, "unknown op"));
        }
    }

    /// The index setters of a vector (17 revert mode, 18 put, 19 delete); true if the op was one.
    function _indexOp(Ctx memory c, uint256 b) internal returns (bool) {
        uint256[] memory o = c.ops;
        uint256 code = o[b];
        if (code == 17) {
            c.index.setRevertFrom(GPU, uint32(o[b + 3]));
        } else if (code == 18) {
            c.index.put(
                GPU,
                uint32(o[b + 3]),
                uint32(o[b + 4]),
                uint64(o[b + 5]),
                IAgateIndex.Status(o[b + 6]),
                uint8(o[b + 7]),
                o[b + 8] & 1 == 1,
                o[b + 8] & 2 == 2
            );
        } else if (code == 19) {
            c.index.del(GPU, uint32(o[b + 3]));
        } else {
            return false;
        }
        return true;
    }

    function _step(Ctx memory c) internal {
        uint256 b = c.op * OP_W;
        uint256[] memory o = c.ops;
        vm.warp(o[b + 2]);
        uint256 err = o[b + 9];
        uint256 r0 = o[b + 10];
        uint256 r1 = o[b + 11];
        if (!_indexOp(c, b)) {
            (address target, bytes memory data, bool view_) = _calldata(c, b);
            vm.recordLogs();
            bool ok;
            bytes memory ret;
            if (view_) {
                (ok, ret) = target.staticcall(data);
            } else {
                vm.prank(_addr(c, o[b + 1]));
                (ok, ret) = target.call(data);
            }
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (err == 0) {
                if (!ok) revert(_at(c, string.concat("reverted, model ok: ", vm.toString(ret))));
                _results(c, o[b], ret, r0, r1);
                _fixes(c, logs);
            } else {
                if (ok) revert(_at(c, string.concat("succeeded, model reverted with error ", vm.toString(err))));
                if (err != OTHER) _eq(c, uint32(bytes4(ret)), uint32(_errSel(err)), "error selector");
            }
            c.digest = keccak256(abi.encode(c.digest, o[b], o[b + 1], err, ok ? ret : bytes("")));
        }
        _state(c);
    }

    function _results(Ctx memory c, uint256 code, bytes memory ret, uint256 r0, uint256 r1) internal pure {
        if (code == 2 || code == 15) {
            (uint256 x, uint256 y) = abi.decode(ret, (uint256, uint256));
            _eq(c, x, r0, "result 0");
            _eq(c, y, r1, "result 1");
        } else if (code <= 1 || code == 3 || code == 4 || (code >= 7 && code <= 10) || code == 14 || code == 16) {
            _eq(c, abi.decode(ret, (uint256)), r0, "result");
        }
    }

    function _fixes(Ctx memory c, Vm.Log[] memory logs) internal pure {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(c.s) || logs[i].topics[0] != FIX_APPLIED) continue;
            if (c.fixAt >= c.nFixes) revert(_at(c, "a FixApplied the model did not emit"));
            uint256 f = c.fixAt * FIX_W;
            _eq(c, c.fixes[f], c.op, "FixApplied in another call");
            (uint32 x, uint32 cl, uint8 st, uint8 fl, uint64 sumAfter) =
                abi.decode(logs[i].data, (uint32, uint32, uint8, uint8, uint64));
            _eq(c, uint256(logs[i].topics[1]), c.fixes[f + 1], "FixApplied k");
            _eq(c, uint256(logs[i].topics[2]), c.fixes[f + 2], "FixApplied day");
            _eq(c, x, c.fixes[f + 3], "FixApplied x");
            _eq(c, cl, c.fixes[f + 4], "FixApplied c");
            _eq(c, st, c.fixes[f + 5], "FixApplied status");
            _eq(c, fl, c.fixes[f + 6], "FixApplied flags");
            _eq(c, sumAfter, c.fixes[f + 7], "FixApplied sumAfter");
            ++c.fixAt;
        }
        if (c.fixAt < c.nFixes && c.fixes[c.fixAt * FIX_W] == c.op) revert(_at(c, "a FixApplied is missing"));
    }

    function _state(Ctx memory c) internal view {
        (uint8 k, uint64 sum,,,, uint128 led, uint256 nextId, uint256 sh) = c.s.state();
        uint256 b = c.op * STATE_W;
        _eq(c, k, c.states[b], "k");
        _eq(c, sum, c.states[b + 1], "S");
        _eq(c, led, c.states[b + 2], "ledger");
        _eq(c, sh, c.states[b + 3], "shortSupply");
        _eq(c, c.tok.totalSupply(), c.states[b + 4], "token supply");
        _eq(c, nextId, c.states[b + 5], "nextId");
    }

    // ------------------------------------------------------------------ the end

    function _end(Ctx memory c, string memory json) internal view {
        uint256[] memory holders = vm.parseJsonUintArray(json, ".holders");
        uint256[] memory d = vm.parseJsonUintArray(json, ".finalDollars");
        uint256[] memory t = vm.parseJsonUintArray(json, ".finalTokens");
        uint256[] memory sh = vm.parseJsonUintArray(json, ".finalShorts");
        for (uint256 i; i < holders.length; ++i) {
            address h = _addr(c, holders[i]);
            _eq(c, c.dollar.balanceOf(h), d[i], "final dollars");
            _eq(c, c.tok.balanceOf(h), t[i], "final tokens");
            _eq(c, c.s.shortOf(h), sh[i], "final short");
        }
        _eq(c, c.dollar.balanceOf(address(c.s)), vm.parseJsonUint(json, ".seriesDollars"), "series dollars");
        _eq(c, c.tok.balanceOf(address(c.s)), vm.parseJsonUint(json, ".seriesTokens"), "series tokens");
        uint256 n = vm.parseJsonUint(json, ".nPositions");
        uint256[] memory p = vm.parseJsonUintArray(json, ".positions");
        for (uint256 id = 1; id <= n; ++id) {
            Position memory x = c.s.position(id);
            uint256 b = (id - 1) * POS_W;
            if (p[b] == 100) {
                _eq(c, uint160(x.owner), 0, "a deleted position");
                continue;
            }
            _eq(c, uint160(x.owner), uint160(_addr(c, p[b])), "position owner");
            _eq(c, uint160(x.payee), uint160(_addr(c, p[b + 1])), "position payee");
            _eq(c, uint160(x.operator), uint160(_addr(c, p[b + 2])), "position operator");
            _eq(c, uint256(x.side), p[b + 3], "position side");
            _eq(c, x.q, p[b + 4], "position q");
            _eq(c, x.paid, p[b + 5], "position paid");
            _eq(c, x.daily ? 1 : 0, p[b + 6], "position daily");
            _eq(c, x.openedK, p[b + 7], "position openedK");
        }
        _eq(c, c.s.position(n + 1).owner == address(0) ? 1 : 0, 1, "no position beyond the model's");
    }

    /// Replays one vector (an external call, so its memory is freed); returns the clock-free digest and the calls.
    function replay(string calldata name) external returns (bytes32 digest, uint256 calls) {
        string memory json = vm.readFile(_path(name));
        Ctx memory c;
        c.name = name;
        _setUp(c, json);
        uint256 n = vm.parseJsonUint(json, ".nOps");
        assertEq(c.ops.length, n * OP_W);
        for (c.op = 0; c.op < n; ++c.op) {
            _step(c);
        }
        if (c.fixAt != c.nFixes) revert(string.concat(name, ": FixApplied events missing at the end"));
        _end(c, json);
        return (c.digest, n);
    }
}
