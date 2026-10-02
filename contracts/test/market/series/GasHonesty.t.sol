// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {AgateSeries} from "../../../src/market/AgateSeries.sol";
import {IAgateToken} from "../../../src/market/interfaces/IAgateToken.sol";
import {U, Side} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I36, gas honesty: for every sync-bearing shape (sync, claim, claimMany, streamOut, settle) and c in {1, 5, 30}
/// pending index calls, the smallest gas limit at which the call succeeds applies every ended day whose fix is final
/// and pays exactly what claimable / previewSync showed; smaller limits revert. On December (N = 31), so streamOut
/// still has an open month after 30 days. Binary search on call{gas: g}, every account cooled before each probe.
contract SeriesGasHonestyTest is SeriesBase {
    AgateSeries internal dec;
    uint256 internal constant N31 = 31;

    function setUp() public override {
        super.setUp();
        dec = _deployDecember();
        s = dec; // the base helpers (_mint, _stream, _k, _S) now act on December
        tok = IAgateToken(dec.token());
    }

    function _afterDec(uint256 kk) internal view returns (uint256) {
        return _dayEnd(DEC1 + uint32(kk) - 1) + tPend + 1;
    }

    function _probe(address caller, bytes memory data, uint256 g) internal returns (bool ok, bytes memory ret) {
        uint256 snap = vm.snapshotState();
        vm.cool(address(dec));
        vm.cool(address(index));
        vm.cool(address(dollar));
        vm.cool(dec.token());
        vm.prank(caller);
        (ok, ret) = address(dec).call{gas: g}(data);
        vm.revertToStateAndDelete(snap);
    }

    /// The smallest g at which the call succeeds; asserts a sample of smaller limits all revert.
    function _smallest(address caller, bytes memory data) internal returns (uint256 lo) {
        lo = 21_000;
        uint256 hi = 10_000_000;
        (bool okHi,) = _probe(caller, data, hi);
        assertTrue(okHi, "the call must succeed with ample gas");
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,) = _probe(caller, data, mid);
            if (ok) hi = mid;
            else lo = mid + 1;
        }
        for (uint256 g = 21_000; g < lo; g += lo / 40 + 1) {
            _assertReverts(caller, data, g);
        }
        for (uint256 i = 1; i <= 16 && i < lo; ++i) {
            _assertReverts(caller, data, lo - i);
        }
    }

    function _assertReverts(address caller, bytes memory data, uint256 g) internal {
        (bool ok, bytes memory ret) = _probe(caller, data, g);
        assertFalse(ok, "a smaller gas limit succeeded");
        assertTrue(ret.length == 0 || _sel(ret) == IAgateSeries.SyncGasLow.selector, "unexpected revert");
    }

    /// Runs the call at exactly g (cooled, like a fresh transaction) and returns its result.
    function _runAt(address caller, bytes memory data, uint256 g) internal returns (bytes memory ret) {
        vm.cool(address(dec));
        vm.cool(address(index));
        vm.cool(address(dollar));
        vm.cool(dec.token());
        vm.prank(caller);
        bool ok;
        (ok, ret) = address(dec).call{gas: g}(data);
        assertTrue(ok);
    }

    function _cs() internal pure returns (uint256[3] memory) {
        return [uint256(1), 5, 30];
    }

    function test_I36_sync() public {
        for (uint256 i; i < 3; ++i) {
            uint256 c = _cs()[i];
            uint256 snap = vm.snapshotState();
            vm.warp(_afterDec(c));
            (uint8 pk, uint64 ps) = dec.previewSync();
            assertEq(pk, c);
            bytes memory data = abi.encodeCall(IAgateSeries.sync, (type(uint256).max));
            uint256 g = _smallest(stranger, data);
            assertEq(abi.decode(_runAt(stranger, data, g), (uint256)), c);
            assertEq(_k(), pk);
            assertEq(_S(), ps);
            emit log_named_uint(string.concat("sync, c = ", vm.toString(c)), g);
            vm.revertToState(snap);
        }
    }

    function test_I36_claim() public {
        _mint(a, 720 * U);
        (uint256 id,) = _stream(a, Side.SHORT, 720 * U, a, b, true);
        for (uint256 i; i < 3; ++i) {
            uint256 c = _cs()[i];
            uint256 snap = vm.snapshotState();
            vm.warp(_afterDec(c));
            uint256 want = dec.claimable(id);
            assertGt(want, 0);
            bytes memory data = abi.encodeCall(IAgateSeries.claim, (id));
            uint256 g = _smallest(payer, data);
            uint256 b0 = dollar.balanceOf(b);
            assertEq(abi.decode(_runAt(payer, data, g), (uint256)), want);
            assertEq(dollar.balanceOf(b) - b0, want);
            assertEq(_k(), c);
            emit log_named_uint(string.concat("claim, c = ", vm.toString(c)), g);
            vm.revertToState(snap);
        }
    }

    function test_I36_claimMany() public {
        _mint(a, 800 * U);
        uint256[] memory ids = new uint256[](8);
        for (uint256 j; j < 8; ++j) {
            (ids[j],) = _stream(a, j % 2 == 0 ? Side.SHORT : Side.LONG, 100 * U, a, b, true);
        }
        for (uint256 i; i < 3; ++i) {
            uint256 c = _cs()[i];
            uint256 snap = vm.snapshotState();
            vm.warp(_afterDec(c));
            uint256 want;
            for (uint256 j; j < 8; ++j) {
                want += dec.claimable(ids[j]);
            }
            bytes memory data = abi.encodeCall(IAgateSeries.claimMany, (ids));
            uint256 g = _smallest(payer, data);
            assertEq(abi.decode(_runAt(payer, data, g), (uint256)), want);
            assertEq(_k(), c);
            emit log_named_uint(string.concat("claimMany(8), c = ", vm.toString(c)), g);
            vm.revertToState(snap);
        }
    }

    function test_I36_streamOut() public {
        _mint(a, 100 * U);
        for (uint256 i; i < 3; ++i) {
            uint256 c = _cs()[i];
            uint256 snap = vm.snapshotState();
            vm.warp(_afterDec(c));
            (uint8 pk, uint64 ps) = dec.previewSync();
            uint256 q = 100 * U;
            uint256 want = q * (uint256(ps) + (N31 - pk) * FLOOR) / (N31 * U);
            bytes memory data = abi.encodeCall(IAgateSeries.streamOut, (Side.LONG, q, a, a, a, true));
            uint256 g = _smallest(a, data);
            (, uint256 paidNow) = abi.decode(_runAt(a, data, g), (uint256, uint256));
            assertEq(paidNow, want);
            assertEq(_k(), c);
            emit log_named_uint(string.concat("streamOut, c = ", vm.toString(c)), g);
            vm.revertToState(snap);
        }
    }

    function test_I36_settle() public {
        _mint(a, 100 * U);
        for (uint256 i; i < 3; ++i) {
            uint256 c = _cs()[i];
            uint256 snap = vm.snapshotState();
            vm.warp(_afterDec(N31 - c));
            dec.sync(type(uint256).max);
            assertEq(_k(), N31 - c);
            vm.warp(_afterDec(N31));
            (uint8 pk, uint64 ps) = dec.previewSync();
            assertEq(pk, N31);
            uint256 want = 100 * U * uint256(ps) / (N31 * U);
            bytes memory data = abi.encodeCall(IAgateSeries.settle, (Side.LONG, 100 * U, a));
            uint256 g = _smallest(a, data);
            assertEq(abi.decode(_runAt(a, data, g), (uint256)), want);
            assertEq(_k(), N31);
            emit log_named_uint(string.concat("settle, c = ", vm.toString(c)), g);
            vm.revertToState(snap);
        }
    }
}
