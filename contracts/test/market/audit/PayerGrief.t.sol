// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {U, Side} from "../../../src/market/MarketTypes.sol";
import {RouterBase} from "../router/RouterBase.sol";

/// Security audit, finding M2 (MEDIUM, phase 3 policy of BUILD-SPEC 6.6). The daily payer claims every daily
/// position with claimable >= $0.01 and pays the gas. Positions cost nothing in dollars (the faucet is free and
/// sybil-able, and a position returns what it locks), so a stranger can open many one-token daily positions once
/// and make the payer pay a claim for each of them every index day. This test measures both sides at Ethereum
/// prices in Foundry (Monad prices cold state higher on both sides) and asserts the payer's month costs more gas
/// than the attacker's setup, i.e. the attack has leverage. It passes on the current code: it documents the
/// economics for the bot policy; no contract change is implied.
/// FIXED in v3.2 at the policy level (BUILD-SPEC 6.6): the payer spends a gas budget per real day, the largest
/// claimable first, so its spend is bounded whatever anyone opens (model test_budget_bounds_the_payer_whatever_
/// strangers_open). The contracts are unchanged, so this measurement stays as the rule's motivation.
contract PayerGriefTest is RouterBase {
    uint256 internal constant P = 40; // positions of one token each
    uint256 internal constant BATCH = 40; // the payer's claimMany size (6.6: at most 50)

    function test_POC_M2_dustDailyPositionsDrainThePayersGas() public {
        _world();
        address attacker = makeAddr("sybil");
        _give(attacker, P * 7_200_000 + 1); // one faucet drip covers about 1,388 such positions

        vm.startPrank(attacker);
        dollar.approve(address(s), type(uint256).max);
        uint256 g0 = gasleft();
        s.mint(P * U, attacker);
        uint256[] memory ids = new uint256[](P);
        for (uint256 i; i < P; ++i) {
            (ids[i],) = s.streamOut(Side.LONG, U, attacker, attacker, attacker, true);
        }
        uint256 attackerGas = g0 - gasleft();
        vm.stopPrank();

        // every position qualifies under 6.6 (claimable >= $0.01) on every day of the month
        vm.warp(_afterDay(1));
        for (uint256 i; i < P; ++i) {
            assertGe(s.claimable(ids[i]), 10_000, "a one-token position earns at least $0.01 a day");
        }

        uint256 payerGas;
        for (uint256 day = 1; day <= 30; ++day) {
            vm.warp(_afterDay(day));
            vm.cool(address(s));
            vm.cool(address(dollar));
            vm.prank(payer);
            uint256 h0 = gasleft();
            s.claimMany(ids);
            payerGas += h0 - gasleft();
        }
        console2.log("attacker gas, once (mint + streamOut x P)", attackerGas);
        console2.log("payer gas over the month (claimMany x 30 days)", payerGas);
        console2.log("leverage x100", payerGas * 100 / attackerGas);
        assertGt(payerGas, attackerGas, "the payer spends more gas than the attacker");

        // and the attacker loses no dollars: every position ended with a final claim (paid S / N per token)
        // and the short units it kept settle for C - S / N
        vm.prank(attacker);
        s.settle(Side.SHORT, P * U, attacker);
        assertGe(dollar.balanceOf(attacker) + P, P * 7_200_000 + 1, "the attacker gets its dollars back (dust aside)");
    }
}
