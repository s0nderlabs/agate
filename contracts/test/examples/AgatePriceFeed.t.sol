// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";
import {AgatePriceFeed} from "../../src/examples/AgatePriceFeed.sol";
import {MockIndex} from "../market/mocks/MockIndex.sol";

/// The example feed over records set by hand (MockIndex, production clock).
contract AgatePriceFeedTest is Test {
    uint32 internal constant DAY = 86_400;
    uint64 internal constant EPOCH = 1_790_000_000 - (1_790_000_000 % 86_400);
    uint32 internal constant EPOCH_DAY = 20_717;
    bytes32 internal constant H100 = keccak256("H100");

    MockIndex internal index;
    AgatePriceFeed internal feed;

    function setUp() public {
        index = new MockIndex(DAY, EPOCH, EPOCH_DAY);
        index.register(H100, keccak256("recipe"));
        feed = new AgatePriceFeed(index, H100, "agate H100 / USD per GPU-hour");
        vm.warp(EPOCH + 10 * uint256(DAY) + 8 hours); // day EPOCH_DAY + 10, 08:00 UTC
        index.setHead(H100, EPOCH_DAY + 10); // yesterday closed: today is the next day to close
    }

    function _final(uint32 d, uint32 value) internal {
        index.put(H100, d, value, uint64(index.dayStart(d + 1) + 7 hours), IAgateIndex.Status.FULL, 5, false, false);
    }

    function test_latest_is_the_newest_final_day() public {
        _final(EPOCH_DAY + 8, 3_950_000);
        _final(EPOCH_DAY + 9, 3_990_000);
        (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) = feed.latestRoundData();
        assertEq(id, EPOCH_DAY + 9);
        assertEq(answer, 3_990_000);
        assertEq(startedAt, index.dayStart(EPOCH_DAY + 9));
        assertEq(updatedAt, index.dayStart(EPOCH_DAY + 10) + 7 hours);
        assertEq(answeredIn, id);
        assertEq(feed.decimals(), 6);
    }

    function test_a_pending_day_is_skipped() public {
        _final(EPOCH_DAY + 8, 3_950_000);
        // yesterday closed but not final yet (finalAt 0: waiting for the countersign)
        index.put(H100, EPOCH_DAY + 9, 4_100_000, 0, IAgateIndex.Status.FULL, 5, false, false);
        (uint80 id, int256 answer,,,) = feed.latestRoundData();
        assertEq(id, EPOCH_DAY + 8);
        assertEq(answer, 3_950_000);
    }

    function test_getRoundData_one_day_and_reverts_without_a_final_record() public {
        _final(EPOCH_DAY + 3, 2_500_000);
        (, int256 answer,,,) = feed.getRoundData(EPOCH_DAY + 3);
        assertEq(answer, 2_500_000);
        vm.expectRevert(AgatePriceFeed.NoFinalPrice.selector);
        feed.getRoundData(EPOCH_DAY + 4);
        vm.expectRevert(AgatePriceFeed.NoFinalPrice.selector);
        feed.getRoundData(uint80(type(uint32).max) + 1);
    }

    function test_no_final_day_at_the_head_reverts() public {
        // nothing closed yet at head - 1 or head - 2 (an index that has not started, or a head moved on by carries)
        _final(EPOCH_DAY + 1, 3_000_000);
        vm.expectRevert(AgatePriceFeed.NoFinalPrice.selector);
        feed.latestRoundData();
        index.setHead(H100, 0);
        vm.expectRevert(AgatePriceFeed.NoFinalPrice.selector);
        feed.latestRoundData();
    }

    function test_the_head_finds_the_newest_final_day_after_a_long_gap() public {
        // a changed day waited 8 days for its countersign: the newest final day is far from today, and still found
        _final(EPOCH_DAY + 1, 3_000_000);
        index.setHead(H100, EPOCH_DAY + 2);
        (uint80 id, int256 answer,,,) = feed.latestRoundData();
        assertEq(id, EPOCH_DAY + 1);
        assertEq(answer, 3_000_000);
    }

    function test_a_carried_day_reports_when_the_price_was_last_computed() public {
        _final(EPOCH_DAY + 7, 3_950_000);
        uint64 computedAt = uint64(index.dayStart(EPOCH_DAY + 8) + 7 hours);
        // two carried days: the price repeats; their finalAt is when they were carried (now-ish)
        index.put(H100, EPOCH_DAY + 8, 3_950_000, uint64(block.timestamp - 2 days), IAgateIndex.Status.CARRIED, 0, false, false);
        index.put(H100, EPOCH_DAY + 9, 3_950_000, uint64(block.timestamp - 1 hours), IAgateIndex.Status.CARRIED, 0, false, false);
        (uint80 id, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(id, EPOCH_DAY + 9);
        assertEq(answer, 3_950_000);
        assertEq(updatedAt, computedAt, "the computed day's finalAt, not the carry time");
    }

    function test_a_carried_day_with_nothing_computed_before_it_is_updatedAt_zero() public {
        index.put(H100, EPOCH_DAY + 9, 3_950_000, uint64(block.timestamp - 1 hours), IAgateIndex.Status.CARRIED, 0, false, false);
        (,,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(updatedAt, 0);
    }

    function test_an_unregistered_gpu_is_refused() public {
        vm.expectRevert(abi.encodeWithSelector(AgatePriceFeed.NotRegistered.selector, keccak256("nope")));
        new AgatePriceFeed(index, keccak256("nope"), "x");
    }
}

/// The example feed against the live index on Monad testnet. Skipped without MONAD_FORK_URL (for example
/// https://testnet-rpc.monad.xyz).
contract AgatePriceFeedForkTest is Test {
    IAgateIndex internal constant INDEX = IAgateIndex(0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36);
    bytes32 internal constant H100 = 0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955;
    uint32 internal constant OCT_4_2026 = 20_730; // the index's first day: H100 final at $3.99

    function test_fork_reads_the_live_h100_price() public {
        string memory url = vm.envOr("MONAD_FORK_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        assertEq(block.chainid, 10_143, "not Monad testnet");
        AgatePriceFeed feed = new AgatePriceFeed(INDEX, H100, "agate H100 / USD per GPU-hour");

        (uint80 id, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        console2.log("newest final day", uint256(id));
        console2.log("H100 USD per GPU-hour, 6 decimals", uint256(answer));
        assertGe(id, OCT_4_2026);
        assertGe(answer, 100_000); // the recipe's bounds: $0.10 to $1,000
        assertLe(answer, 1_000_000_000);
        assertLe(updatedAt, block.timestamp);
        (bool ok, uint32 value,,,,) = INDEX.finalFix(H100, uint32(id));
        assertTrue(ok);
        assertEq(uint256(answer), value, "the feed answers the index's own final value");

        (, int256 first,,,) = feed.getRoundData(OCT_4_2026);
        assertEq(first, 3_990_000);
    }
}
