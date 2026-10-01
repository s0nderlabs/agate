// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {AgateIndex} from "../../src/AgateIndex.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";
import {IReceiver, IERC165} from "../../src/interfaces/IReceiver.sol";

contract ConstructorTest is IndexBase {
    function setUp() public {
        P = TEST_P();
        vm.warp(T0);
    }

    function _bad(IAgateIndex.InitParams memory ip) internal {
        vm.expectRevert(IAgateIndex.BadInit.selector);
        new AgateIndex(ip);
    }

    function test_clocks_fourProfiles() public {
        uint32[4] memory tp = [uint32(21_600), 210, 6, 600];
        Profile[4] memory ps = [PROD_P(), DEMO_P(), FAST_P(), TEST_P()];
        for (uint256 k; k < 4; ++k) {
            vm.warp(T0 + 10 * 86_400);
            AgateIndex a = new AgateIndex(initParams(ps[k]));
            IAgateIndex.Clocks memory c = a.clocks();
            uint32 day = ps[k].day;
            assertEq(c.day, day);
            assertEq(c.slice, day / ps[k].slices);
            assertEq(c.tPend, tp[k], "tPend");
            assertEq(c.closeGrace, day / ps[k].slices);
            assertEq(c.grace, day, "GRACE = DAY");
            assertEq(c.reopenWait, day / 4, "REOPEN_WAIT = DAY/4");
            assertEq(c.holdMove, 7 * day);
            assertEq(c.holdMin, 3 * day / 4);
            assertEq(c.step, day / 6);
            assertEq(c.timelock, 2 * day);
            assertEq(c.slices, ps[k].slices);
            assertEq(c.minReadings, ps[k].minReadings);
            assertEq(c.qMin, ps[k].qMin);
            assertEq(c.signAll, ps[k].signAll);
            assertEq(c.demoLabel, ps[k].demo);
            assertEq(c.chainSelector, CHAIN);
            // I17: STEP + HOLD_MIN < DAY
            assertLt(uint256(c.step) + c.holdMin, day);
        }
    }

    function test_testProfileWithSignAllKeepsTPend() public {
        Profile memory p = TEST_P();
        p.signAll = true;
        AgateIndex a = new AgateIndex(initParams(p));
        assertEq(a.clocks().tPend, 600);
        assertTrue(a.clocks().signAll);
    }

    function test_fastWithoutSignAllReverts() public {
        Profile memory p = FAST_P();
        p.signAll = false;
        _bad(initParams(p));
    }

    function test_badInit_eachCheck() public {
        IAgateIndex.InitParams memory ip;
        ip = initParams(TEST_P());
        ip.day = 2_401; // DAY % SLICES and DAY % 12
        _bad(ip);
        ip = initParams(TEST_P());
        ip.day = 2_412; // divisible by 12, not by 12 slices? 2412/12 = 201: ok; make slices 24 -> 2412 % 24 != 0
        ip.slices = 24;
        ip.minReadings = 12;
        _bad(ip);
        ip = initParams(TEST_P());
        ip.day = 2_420; // % 12 != 0, % 10 == 0
        ip.slices = 10;
        ip.minReadings = 5;
        _bad(ip);
        ip = initParams(TEST_P());
        ip.slices = 0;
        _bad(ip);
        ip = initParams(TEST_P());
        ip.day = 0;
        _bad(ip);
        ip = initParams(TEST_P());
        ip.minReadings = 0;
        _bad(ip);
        ip = initParams(TEST_P());
        ip.minReadings = 13;
        _bad(ip);
        ip = initParams(TEST_P());
        ip.qMin = 0;
        _bad(ip);
        ip = initParams(TEST_P());
        ip.qMin = 2; // below 3 without the DEMO label
        _bad(ip);
        ip = initParams(TEST_P());
        ip.epochTs = uint64(block.timestamp + 1);
        _bad(ip);
        ip = initParams(TEST_P());
        ip.owner = address(0);
        _bad(ip);
        ip = initParams(TEST_P());
        ip.writers[0] = address(0);
        _bad(ip);
        ip = initParams(TEST_P());
        ip.attester = address(0);
        _bad(ip);
        ip = initParams(TEST_P());
        ip.guardians[0] = address(0);
        _bad(ip);
        // every role distinct
        ip = initParams(TEST_P());
        ip.writers[1] = ip.writers[0];
        _bad(ip);
        ip = initParams(TEST_P());
        ip.attester = ip.guardians[1];
        _bad(ip);
        ip = initParams(TEST_P());
        ip.owner = ip.attester;
        _bad(ip);
        // DAY that would overflow 7 DAY in uint32
        ip = initParams(TEST_P());
        ip.day = uint32(type(uint32).max / 7 / 12 * 12 + 12);
        ip.slices = 12;
        _bad(ip);
    }

    function test_badInit_roleWithCode() public {
        address[5] memory who = [w1, w2, att, g1, g2];
        for (uint256 i; i < 5; ++i) {
            vm.etch(who[i], hex"00");
            _bad(initParams(TEST_P()));
            vm.etch(who[i], "");
        }
        // the owner may be a contract (a multisig)
        vm.etch(owner, hex"00");
        new AgateIndex(initParams(TEST_P()));
    }

    function test_optionalSecondSlots() public {
        IAgateIndex.InitParams memory ip = initParams(TEST_P());
        ip.writers[1] = address(0);
        ip.guardians[1] = address(0);
        AgateIndex a = new AgateIndex(ip);
        assertEq(a.writers()[1], address(0));
        assertEq(a.guardians()[1], address(0));
    }

    function test_demoAllowsQMinOne() public {
        Profile memory p = DEMO_P();
        AgateIndex a = new AgateIndex(initParams(p));
        assertEq(a.clocks().qMin, 1);
    }

    function test_rolesAndInterfaces() public {
        AgateIndex a = new AgateIndex(initParams(TEST_P()));
        assertEq(a.owner(), owner);
        assertEq(a.writers()[0], w1);
        assertEq(a.writers()[1], w2);
        assertEq(a.attester(), att);
        assertEq(a.guardians()[0], g1);
        (address f, IAgateIndex.WriterMode m) = a.forwarder();
        assertEq(f, address(0));
        assertEq(uint8(m), 0);
        assertTrue(a.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(a.supportsInterface(type(IERC165).interfaceId));
        assertTrue(a.supportsInterface(bytes4(keccak256("onReport(bytes,bytes)"))));
        assertFalse(a.supportsInterface(0xffffffff));
        assertFalse(a.supportsInterface(type(IAgateIndex).interfaceId));
    }

    function test_dayIdAndDayStart() public {
        AgateIndex a = new AgateIndex(initParams(TEST_P()));
        assertEq(a.dayId(uint64(T0)), OCT1);
        assertEq(a.dayId(uint64(T0 - 1)), OCT1, "before the epoch: EPOCH_DAY");
        assertEq(a.dayId(uint64(T0 + 2_399)), OCT1);
        assertEq(a.dayId(uint64(T0 + 2_400)), OCT1 + 1);
        assertEq(a.dayStart(OCT1 + 3), T0 + 3 * 2_400);
        assertEq(a.dayStart(OCT1 - 1), T0, "before the epoch day: never reverts");
        assertEq(a.dayId(type(uint64).max), type(uint32).max, "saturates");
        AgateIndex prod = new AgateIndex(initParams(PROD_P()));
        assertEq(prod.dayId(1_793_491_200), NOV1, "UTC day count");
        assertEq(prod.dayStart(NOV1), 1_793_491_200);
    }
}
