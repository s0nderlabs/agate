// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, Side, FIX_CALL_GAS, SYNC_ROUND_GAS} from "../../../src/market/MarketTypes.sol";
import {GasBase} from "./GasBase.sol";

/// The series shapes of BUILD-SPEC 9.2 on December (N = 31) over the real AgateIndex, for c (index calls the call
/// makes) in {0, 1, 5, 30} for every shape that syncs (9.1 step 4). c = 0 is a synced series with the current day
/// running; for settle and the final claim, every day but the last c applied.
contract SeriesGasTest is GasBase {
    uint256 internal constant RESERVE = FIX_CALL_GAS * 64 / 63 + SYNC_ROUND_GAS;

    function setUp() public {
        _world();
    }

    function _c(string memory shape, uint256 c) internal pure returns (string memory) {
        return string.concat(shape, ", c = ", vm.toString(c));
    }

    // ------------------------------------------------------------------ pairs and the owner's calls (no index call)

    function test_gas_pairsAndOwnerCalls() public {
        address fresh = makeAddr("fresh");
        _fundUser(fresh);
        _m(
            "mint 100 tokens, holder new to both balances",
            fresh,
            address(dec),
            abi.encodeCall(IAgateSeries.mint, (100 * U, fresh)),
            address(0),
            0
        );
        vm.prank(alice);
        dec.mint(720 * U, alice);
        _m(
            "mint 100 tokens, existing holder",
            alice,
            address(dec),
            abi.encodeCall(IAgateSeries.mint, (100 * U, alice)),
            address(0),
            0
        );
        _m(
            "redeem 100 tokens",
            alice,
            address(dec),
            abi.encodeCall(IAgateSeries.redeem, (100 * U, alice)),
            address(0),
            0
        );
        vm.startPrank(alice);
        (uint256 sid,) = dec.streamOut(Side.SHORT, 100 * U, alice, alice, alice, true);
        (uint256 lid,) = dec.streamOut(Side.LONG, 100 * U, alice, alice, alice, true);
        vm.stopPrank();
        _m("setPayout", alice, address(dec), abi.encodeCall(IAgateSeries.setPayout, (sid, bob, false)), address(0), 0);
        _m("setOperator", alice, address(dec), abi.encodeCall(IAgateSeries.setOperator, (sid, bob)), address(0), 0);
        _m(
            "closeWithToken, SHORT position (burns tokens)",
            alice,
            address(dec),
            abi.encodeCall(IAgateSeries.closeWithToken, (sid, alice)),
            address(0),
            0
        );
        _m(
            "closeWithToken, LONG position (debits short)",
            alice,
            address(dec),
            abi.encodeCall(IAgateSeries.closeWithToken, (lid, alice)),
            address(0),
            0
        );
        _m(
            "unstream, LONG position (takes paid, mints)",
            alice,
            address(dec),
            abi.encodeCall(IAgateSeries.unstream, (lid, alice)),
            address(0),
            0
        );
        _m(
            "unstream, SHORT position (credits short)",
            alice,
            address(dec),
            abi.encodeCall(IAgateSeries.unstream, (sid, alice)),
            address(0),
            0
        );
    }

    // ------------------------------------------------------------------ sync

    function test_gas_sync() public {
        uint256[3] memory cs = [uint256(1), 5, 30];
        for (uint256 i; i < 3; ++i) {
            uint256 c = cs[i];
            _decPending(c);
            M memory all = _m(
                _c("sync(all)", c),
                payer,
                address(dec),
                abi.encodeCall(IAgateSeries.sync, (type(uint256).max)),
                address(dec),
                c
            );
            assertGe(all.limit, RESERVE, "a round for an ended day needs the reserve");
            if (c == 1) {
                _m("sync(1), c = 1", payer, address(dec), abi.encodeCall(IAgateSeries.sync, (1)), address(dec), 1);
            }
        }
        _decPending(31);
        _m(
            "sync(all), c = 31 (the whole month)",
            payer,
            address(dec),
            abi.encodeCall(IAgateSeries.sync, (type(uint256).max)),
            address(dec),
            31
        );
        dec.sync(type(uint256).max);
        _m(
            "sync, c = 0 (nothing pending)",
            payer,
            address(dec),
            abi.encodeCall(IAgateSeries.sync, (type(uint256).max)),
            address(dec),
            31
        );
    }

    // ------------------------------------------------------------------ streamOut

    function test_gas_streamOut() public {
        vm.prank(alice);
        dec.mint(10_000 * U, alice);
        uint256[3] memory cs = [uint256(1), 5, 30];
        for (uint256 i; i < 3; ++i) {
            uint256 c = cs[i];
            _decPending(c);
            bytes memory data = abi.encodeCall(IAgateSeries.streamOut, (Side.LONG, 100 * U, alice, bob, alice, true));
            _m(_c("streamOut LONG", c), alice, address(dec), data, address(dec), c);
            bytes memory dataS = abi.encodeCall(IAgateSeries.streamOut, (Side.SHORT, 100 * U, alice, bob, alice, true));
            _m(_c("streamOut SHORT", c), alice, address(dec), dataS, address(dec), c);
            if (c == 1) {
                uint256 snap = vm.snapshotState();
                dec.sync(type(uint256).max);
                _m("streamOut LONG, c = 0", alice, address(dec), data, address(dec), 1);
                data = abi.encodeCall(IAgateSeries.streamOut, (Side.SHORT, 100 * U, alice, bob, alice, true));
                _m("streamOut SHORT, c = 0", alice, address(dec), data, address(dec), 1);
                vm.revertToStateAndDelete(snap);
            }
        }
    }

    // ------------------------------------------------------------------ claim, claimMany

    function _positions(uint256 count) internal returns (uint256[] memory ids) {
        vm.prank(alice);
        dec.mint(count * 100 * U, alice);
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            vm.prank(alice);
            (ids[i],) = dec.streamOut(i % 2 == 0 ? Side.SHORT : Side.LONG, 100 * U, alice, bob, alice, true);
        }
    }

    function _first(uint256[] memory ids, uint256 count) internal pure returns (uint256[] memory out) {
        out = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = ids[i];
        }
    }

    function test_gas_claim() public {
        uint256[] memory all = _positions(50);
        uint256[] memory ids = _first(all, 16);
        uint256[] memory one = _first(all, 1);
        uint256[] memory eight = _first(all, 8);
        uint256[3] memory cs = [uint256(1), 5, 30];
        for (uint256 i; i < 3; ++i) {
            uint256 c = cs[i];
            _decPending(c);
            _m(_c("claim", c), payer, address(dec), abi.encodeCall(IAgateSeries.claim, (ids[0])), address(dec), c);
            // the payer's batch after c pending days (9.1 step 3 caps it at 1.5 x this LIMIT)
            _m(
                _c("claimMany 8 ids", c),
                payer,
                address(dec),
                abi.encodeCall(IAgateSeries.claimMany, (eight)),
                address(dec),
                c
            );
            if (c == 1) {
                _m(
                    "claimMany 50 ids (the payer's largest batch, 6.6), c = 1",
                    payer,
                    address(dec),
                    abi.encodeCall(IAgateSeries.claimMany, (all)),
                    address(dec),
                    1
                );
                _m(
                    "claimMany 1 id, c = 1",
                    payer,
                    address(dec),
                    abi.encodeCall(IAgateSeries.claimMany, (one)),
                    address(dec),
                    1
                );
                _m(
                    "claimMany 16 ids, c = 1",
                    payer,
                    address(dec),
                    abi.encodeCall(IAgateSeries.claimMany, (ids)),
                    address(dec),
                    1
                );
                uint256 snap = vm.snapshotState();
                dec.sync(type(uint256).max);
                _m("claim, c = 0", payer, address(dec), abi.encodeCall(IAgateSeries.claim, (ids[0])), address(dec), 1);
                _m(
                    "claimMany 8 ids, c = 0",
                    payer,
                    address(dec),
                    abi.encodeCall(IAgateSeries.claimMany, (eight)),
                    address(dec),
                    1
                );
                vm.revertToStateAndDelete(snap);
            }
        }
        // the final claim deletes the position; the payer's final sweep is claimMany after the last day
        _decPending(31);
        for (uint256 i; i < 3; ++i) {
            uint256 c = cs[i];
            uint256 snap2 = vm.snapshotState();
            dec.sync(31 - c);
            _m(
                _c("claim final (deletes)", c),
                payer,
                address(dec),
                abi.encodeCall(IAgateSeries.claim, (ids[0])),
                address(dec),
                31
            );
            _m(
                _c("claimMany 8 ids, final (deletes)", c),
                payer,
                address(dec),
                abi.encodeCall(IAgateSeries.claimMany, (eight)),
                address(dec),
                31
            );
            vm.revertToStateAndDelete(snap2);
        }
        uint256 snap3 = vm.snapshotState();
        dec.sync(31);
        _m(
            "claim final (deletes), c = 0",
            payer,
            address(dec),
            abi.encodeCall(IAgateSeries.claim, (ids[0])),
            address(dec),
            31
        );
        vm.revertToStateAndDelete(snap3);
    }

    // ------------------------------------------------------------------ settle

    function test_gas_settle() public {
        vm.prank(alice);
        dec.mint(720 * U, alice);
        _decPending(31);
        uint256[3] memory cs = [uint256(1), 5, 30];
        for (uint256 i; i < 3; ++i) {
            uint256 c = cs[i];
            uint256 snap = vm.snapshotState();
            dec.sync(31 - c);
            _m(
                _c("settle LONG", c),
                alice,
                address(dec),
                abi.encodeCall(IAgateSeries.settle, (Side.LONG, 720 * U, alice)),
                address(dec),
                31
            );
            _m(
                _c("settle SHORT", c),
                alice,
                address(dec),
                abi.encodeCall(IAgateSeries.settle, (Side.SHORT, 720 * U, alice)),
                address(dec),
                31
            );
            vm.revertToStateAndDelete(snap);
        }
        dec.sync(31);
        _m(
            "settle LONG, c = 0",
            alice,
            address(dec),
            abi.encodeCall(IAgateSeries.settle, (Side.LONG, 720 * U, alice)),
            address(dec),
            31
        );
        _m(
            "settle SHORT, c = 0",
            alice,
            address(dec),
            abi.encodeCall(IAgateSeries.settle, (Side.SHORT, 720 * U, alice)),
            address(dec),
            31
        );
    }

    // ------------------------------------------------------------------ the first forced day, with the full walk

    /// The index stops after Nov 30: January (listed in December, RULE from Nov 26 to 30) has no fix on Jan 1 and the
    /// walk reads all 31 days of December (no record) before falling back to x0: 32 index calls in one round.
    function test_gas_firstForcedDayFullWalk() public {
        _feed(DEC1 - 1);
        warpTo(dStart(DEC1) + 1);
        IAgateSeries jan = IAgateSeries(fac.list(GPU, JAN));
        warpTo(uint256(jan.terms().startTs) + jan.terms().day + jan.terms().lastResort);
        vm.cool(address(jan));
        _mJan(jan);
    }

    function _mJan(IAgateSeries jan) internal {
        address prevDec = address(dec);
        dec = jan; // so _coolAll cools the January series and its token
        decTok = IERC20(jan.token());
        M memory r = _m(
            "sync(1), first forced day with the full 31-day walk (32 index calls)",
            payer,
            address(jan),
            abi.encodeCall(IAgateSeries.sync, (1)),
            address(jan),
            1
        );
        (,, uint32 lastX, bool walked,,,,) = jan.state();
        assertFalse(walked, "rolled back");
        jan.sync(1);
        (,, lastX, walked,,,,) = jan.state();
        assertTrue(walked);
        assertEq(lastX, jan.terms().x0, "nothing in December: x0");
        assertGe(r.limit, RESERVE, "a round for an ended day needs the reserve");
        dec = IAgateSeries(prevDec);
    }
}
