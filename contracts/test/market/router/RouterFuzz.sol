// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {U, LOT, Side, Position} from "../../../src/market/MarketTypes.sol";
import {RouterBase} from "./RouterBase.sol";

/// The model's TestRouterFuzz and the recheck's TestR5RouterWithKuruFees as one engine: a random multi-level book,
/// three users with standing allowances, random flows (and time) with the app's own quotes (simulation, quoteFor).
/// After every step: I25 (the router holds nothing, no allowance), I37 (the Routed event is the caller's exact
/// balance change), I33 (every position the router opens is the caller's with the router as operator; in a router
/// flow every short credit and debit and every token burn is the router's own), and every revert is an expected one
/// (never RouterKeptSomething, PullInexact or a panic).
abstract contract RouterFuzz is RouterBase {
    bytes32 internal constant SHORT_CREDITED = keccak256("ShortCredited(address,uint256,uint256)");
    bytes32 internal constant SHORT_DEBITED = keccak256("ShortDebited(address,uint256,uint256)");
    bytes32 internal constant TRANSFER = keccak256("Transfer(address,address,uint256)");

    struct Stats {
        uint256[7] ok; // long, longDaily, short, closeLong, closeShort, closeLongDaily, time
        uint256 routed;
        uint256 offGrid; // buys that came back off the lot grid (taker fee)
    }

    uint256 internal rng;
    uint256[] internal routerIds;
    address[3] internal users;
    address internal treasury = makeAddr("treasury");

    function _rand(uint256 n) internal returns (uint256) {
        rng = uint256(keccak256(abi.encode(rng)));
        return rng % n;
    }

    function _fuzzWorld(uint256 seed, uint256 takerFeeBps, uint256 makerFeeBps) internal {
        rng = seed;
        delete routerIds;
        _world(address(new AgateDollar(address(this), 10_000 * U, 86_400)), takerFeeBps, makerFeeBps);
        _maker(200_000 * U);
        uint256 mid = (250 + _rand(350)) * 10_000;
        uint256 n = 1 + _rand(5);
        for (uint256 i; i < n; ++i) {
            _ask(uint32(mid + (i + 1) * (1 + _rand(4)) * 10_000), (1 + _rand(3_999)) * U);
            _bid(uint32(mid - (i + 1) * (1 + _rand(4)) * 10_000), (1 + _rand(3_999)) * U);
        }
        users[0] = _user("u1", 1_000_000 * U);
        users[1] = _user("u2", 1_000_000 * U);
        users[2] = _user("u3", 1_000_000 * U);
    }

    function _run(uint256 steps, Stats memory st) internal {
        for (uint256 i; i < steps; ++i) {
            _step(st);
        }
    }

    function _step(Stats memory st) internal {
        address u = users[_rand(3)];
        uint256 flow = _rand(7);
        uint256 d0 = dollar.balanceOf(u);
        uint256 t0 = token.balanceOf(u);
        vm.recordLogs();
        bool ok;
        if (flow == 0) ok = _fLong(u);
        else if (flow == 1) ok = _fLongDaily(u, st);
        else if (flow == 2) ok = _fShort(u);
        else if (flow == 3) ok = _fCloseLong(u);
        else if (flow == 4) ok = _fCloseShort(u);
        else if (flow == 5) ok = _fCloseLongDaily(u);
        else ok = _fTime();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (ok) {
            st.ok[flow]++;
            if (flow < 6) {
                _assertRoutedTruth(_routed(logs), u, d0, t0);
                _assertRouterOnlyActsOnItsOwn(logs);
                st.routed++;
            }
        }
        _holdsNothing(0, 0);
    }

    // ------------------------------------------------------------------ flows

    function _fLong(address u) internal returns (bool) {
        uint256 qin = (1 + _rand(20_000)) * 1_000;
        (uint256 got,) = m.simulateBuy(qin);
        uint256 minOut = got > LOT && _rand(3) == 0 ? got - LOT : got;
        if (minOut == 0) minOut = 1;
        uint256 t0 = token.balanceOf(u);
        uint256 d0 = dollar.balanceOf(u);
        vm.prank(u);
        try router.openLong(address(s), qin, minOut, _none()) returns (uint256 out) {
            assertEq(out, got, "long: the simulation is the fill");
            assertEq(token.balanceOf(u) - t0, out);
            assertLe(d0 - dollar.balanceOf(u), qin, "long: the unused quote comes back");
            return true;
        } catch (bytes memory err) {
            _expected(err);
            return false;
        }
    }

    function _fLongDaily(address u, Stats memory st) internal returns (bool) {
        uint256 qin = (1 + _rand(20_000)) * 1_000;
        (uint256 got,) = m.simulateBuy(qin);
        uint256 parts = 1 + _rand(4);
        address payee = _rand(2) == 0 ? u : treasury;
        uint256 t0 = token.balanceOf(u);
        vm.prank(u);
        try router.openLongDaily(address(s), qin, got == 0 ? 1 : got, parts, payee, _none()) returns (
            uint256[] memory ids
        ) {
            uint256 per = got / parts / LOT * LOT;
            assertEq(ids.length, parts);
            for (uint256 i; i < parts; ++i) {
                _assertMine(ids[i], u, Side.LONG, payee);
                assertEq(uint256(s.position(ids[i]).q), per, "longDaily: whole lots per part");
                routerIds.push(ids[i]);
            }
            assertEq(token.balanceOf(u) - t0, got - per * parts, "longDaily: the remainder comes back");
            if (got % LOT != 0) st.offGrid++;
            return true;
        } catch (bytes memory err) {
            _expected(err);
            return false;
        }
    }

    function _fShort(address u) internal returns (bool) {
        uint256 parts = 1 + _rand(4);
        uint256 q = parts * (1 + _rand(2_000)) * LOT;
        address payee = _rand(2) == 0 ? u : treasury;
        bool daily = _rand(2) == 0;
        vm.prank(u);
        try router.openShort(address(s), q, 1, parts, payee, daily, _none()) returns (
            uint256[] memory ids, uint256 cost, uint256
        ) {
            assertEq(cost, q * C / U);
            for (uint256 i; i < parts; ++i) {
                _assertMine(ids[i], u, Side.SHORT, payee);
                assertEq(uint256(s.position(ids[i]).q), q / parts);
                assertEq(s.position(ids[i]).daily, daily);
                routerIds.push(ids[i]);
            }
            return true;
        } catch (bytes memory err) {
            _expected(err);
            return false;
        }
    }

    function _fCloseLong(address u) internal returns (bool) {
        uint256 q = token.balanceOf(u) / LOT * LOT;
        if (q == 0) return false;
        vm.prank(u);
        try router.closeLong(address(s), q, 1, _none()) returns (uint256) {
            return true;
        } catch (bytes memory err) {
            _expected(err);
            return false;
        }
    }

    function _fCloseShort(address u) internal returns (bool) {
        (uint256[] memory ids, uint256 q, uint256 paidSum) = _pick(u, Side.SHORT);
        if (ids.length == 0) return false;
        (bool fillable, uint256 quote) = m.quoteFor(q); // the app's quote: the smallest quote buying q
        if (!fillable) return false;
        uint256[4] memory heads = [uint256(0), 0, 365, 10 * U];
        uint256 head = heads[_rand(4)];
        vm.prank(u);
        try router.closeShort(address(s), ids, quote + head, _none()) returns (uint256 pay, uint256, uint256 refund) {
            assertEq(pay, q * C / U - paidSum, "closeShort: the full pair minus paid");
            assertLe(refund, head, "closeShort: at most the headroom comes back");
            for (uint256 i; i < ids.length; ++i) {
                assertEq(s.position(ids[i]).owner, address(0));
            }
            return true;
        } catch (bytes memory err) {
            _expected(err);
            return false;
        }
    }

    function _fCloseLongDaily(address u) internal returns (bool) {
        (uint256[] memory ids, uint256 q, uint256 paidSum) = _pick(u, Side.LONG);
        if (ids.length == 0) return false;
        vm.prank(u);
        try router.closeLongDaily(address(s), ids, 1, _none()) returns (uint256 cost, uint256, uint256 paid) {
            assertEq(cost, q * C / U);
            assertEq(paid, q * C / U - paidSum);
            return true;
        } catch (bytes memory err) {
            _expected(err);
            return false;
        }
    }

    function _fTime() internal returns (bool) {
        uint256[3] memory steps = [uint256(1 hours), 1 days, 4 days];
        vm.warp(block.timestamp + steps[_rand(3)]);
        s.sync(31);
        return true;
    }

    // ------------------------------------------------------------------ helpers

    /// Up to three of u's open positions on `side` that the router operates.
    function _pick(address u, Side side) internal returns (uint256[] memory ids, uint256 q, uint256 paidSum) {
        uint256[] memory live = new uint256[](routerIds.length);
        uint256 n;
        for (uint256 i; i < routerIds.length; ++i) {
            Position memory p = s.position(routerIds[i]);
            if (p.owner == u && p.side == side && p.operator == address(router)) live[n++] = routerIds[i];
        }
        if (n == 0) return (ids, 0, 0);
        uint256 take = 1 + _rand(n < 3 ? n : 3);
        uint256 start = _rand(n);
        ids = new uint256[](take);
        for (uint256 i; i < take; ++i) {
            ids[i] = live[(start + i) % n];
            Position memory p = s.position(ids[i]);
            q += p.q;
            paidSum += p.paid;
        }
    }

    function _assertMine(uint256 id, address u, Side side, address payee) internal view {
        Position memory p = s.position(id);
        assertEq(p.owner, u, "I33 owner is the caller");
        assertEq(p.operator, address(router), "I33 operator is the router");
        assertEq(p.payee, payee);
        assertEq(uint8(p.side), uint8(side));
    }

    /// I33 / I12 inside a router flow: every short credit and debit is the router's own, every token burn is from
    /// the router (the series burns only from its caller).
    function _assertRouterOnlyActsOnItsOwn(Vm.Log[] memory logs) internal view {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter == address(s) && (l.topics[0] == SHORT_CREDITED || l.topics[0] == SHORT_DEBITED)) {
                assertEq(address(uint160(uint256(l.topics[1]))), address(router), "I33 a user's short moved");
            }
            if (l.emitter == address(token) && l.topics[0] == TRANSFER && l.topics[2] == bytes32(0)) {
                assertEq(address(uint160(uint256(l.topics[1]))), address(router), "I12 a burn not from the router");
            }
        }
    }

    /// A flow may fail (slippage, a short book, the month over, a balance), but never because the router kept
    /// something, mis-measured a pull, or hit a panic.
    function _expected(bytes memory err) internal pure {
        bytes4 sel;
        if (err.length >= 4) sel = bytes4(err);
        assertTrue(sel != IAgateRouter.RouterKeptSomething.selector, "RouterKeptSomething");
        assertTrue(sel != IAgateRouter.PullInexact.selector, "PullInexact");
        assertTrue(sel != bytes4(0x4e487b71), "panic");
        assertTrue(err.length >= 4, "empty revert");
    }
}
