// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, Side, CloseKind, Position} from "../../../src/market/MarketTypes.sol";
import {RouterBase} from "./RouterBase.sol";

/// I33 (BUILD-SPEC 6.1 option (c)): every position the router opens has owner = msg.sender and operator = router;
/// it closes only msg.sender's positions, paying the owner; it never debits a user's short balance; it cannot close
/// a position whose operator it is not (the owner's explicit, per-position, revocable grant).
contract RouterAuthorityTest is RouterBase {
    bytes32 internal constant SHORT_CREDITED = keccak256("ShortCredited(address,uint256,uint256)");
    bytes32 internal constant SHORT_DEBITED = keccak256("ShortDebited(address,uint256,uint256)");

    address internal alice;
    address internal mallory;

    function setUp() public {
        _bookWorld();
        alice = _user("alice", 100_000 * U);
        mallory = _user("mallory", 100_000 * U);
        vm.prank(alice);
        dollar.approve(address(s), type(uint256).max);
    }

    function test_I33_positionsBelongToTheCallerAndNameTheRouter() public {
        address aliceTreasury = makeAddr("alice-treasury");
        (uint256[] memory ids,,) = _short(alice, 100 * U, U, 2, aliceTreasury, true);
        for (uint256 i; i < ids.length; ++i) {
            Position memory p = s.position(ids[i]);
            assertEq(p.owner, alice);
            assertEq(p.operator, address(router));
            assertEq(p.payee, aliceTreasury);
        }
        uint256 lid = _longDaily(alice, 364 * U, 100 * U, 1, alice)[0];
        assertEq(s.position(lid).owner, alice);
        assertEq(s.position(lid).operator, address(router));
    }

    function test_I33_routerClosesOnlyTheCallersPositions_payingTheOwner() public {
        (uint256[] memory ids,,) = _short(alice, 100 * U, U, 1, alice, true);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NotYourPosition.selector, ids[0]));
        router.closeShort(address(s), ids, 400 * U, _none());
        vm.expectEmit(address(s));
        emit IAgateSeries.PositionClosed(ids[0], alice, CloseKind.WITH_TOKEN, 720 * U, alice, address(router));
        (uint256 paid,,) = _closeShort(alice, ids, 364 * U);
        assertEq(paid, 720 * U); // paid nothing yet at k = 0
    }

    /// A position opened directly has no operator: the router cannot close it until the owner grants it, for that
    /// one position; a revoked grant stops it again.
    function test_I33_routerCannotTouchAPositionItDidNotOpen() public {
        vm.startPrank(alice);
        s.mint(100 * U, alice);
        (uint256 pid,) = s.streamOut(Side.SHORT, 100 * U, alice, alice, alice, true);
        vm.stopPrank();
        assertEq(s.position(pid).operator, address(0));
        vm.prank(alice);
        vm.expectRevert(IAgateSeries.NotOwnerOrOperator.selector);
        router.closeShort(address(s), _ids(pid), 364 * U, _none());
        vm.prank(alice);
        s.setOperator(pid, address(router));
        _closeShort(alice, _ids(pid), 364 * U);
        assertEq(s.position(pid).owner, address(0));
    }

    function test_I33_ownerRevokesTheRouter() public {
        (uint256[] memory ids,,) = _short(alice, 100 * U, U, 1, alice, true);
        uint256 lid = _longDaily(alice, 364 * U, 100 * U, 1, alice)[0];
        vm.startPrank(alice);
        s.setOperator(ids[0], address(0));
        s.setOperator(lid, address(0));
        vm.expectRevert(IAgateSeries.NotOwnerOrOperator.selector);
        router.closeShort(address(s), ids, 364 * U, _none());
        vm.expectRevert(IAgateSeries.NotOwnerOrOperator.selector);
        router.closeLongDaily(address(s), _ids(lid), U, _none());
        s.setOperator(ids[0], address(router));
        vm.stopPrank();
        _closeShort(alice, ids, 364 * U);
    }

    /// The router never touches a fungible short: alice's own short balance is the same after every flow, and in
    /// every router flow each short credit and debit is the router's own.
    function test_I33_routerNeverTouchesFungibleShorts() public {
        vm.prank(alice);
        s.mint(100 * U, alice);
        uint256 before = s.shortOf(alice);
        vm.recordLogs();
        (uint256[] memory sids,,) = _short(alice, 50 * U, U, 1, alice, true);
        _long(alice, 364 * U, U);
        uint256[] memory lids = _longDaily(alice, 364 * U, 100 * U, 1, alice);
        _closeShort(alice, sids, 200 * U);
        _closeLongDaily(alice, lids, U);
        _closeLong(alice, 100 * U, U);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(s)) continue;
            if (logs[i].topics[0] != SHORT_CREDITED && logs[i].topics[0] != SHORT_DEBITED) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), address(router));
            ++n;
        }
        assertEq(n, 4); // openShort: credit + debit; closeLongDaily: credit + debit
        assertEq(s.shortOf(alice), before);
    }

    /// The recheck's R10: one id the router does not operate reverts the whole batch, leaving everything as it was.
    function test_I33_oneUnoperatedIdRevertsTheWholeBatch() public {
        (uint256[] memory r1,,) = _short(alice, 10 * U, 1, 1, alice, true);
        vm.startPrank(alice);
        s.mint(10 * U, mm); // alice's own fungible short, the tokens elsewhere
        (uint256 p2,) = s.streamOut(Side.SHORT, 10 * U, alice, alice, alice, true); // operator: none
        vm.stopPrank();
        uint256 d0 = dollar.balanceOf(alice);
        uint256 askDepth = m.depthAt(true, 3_640_000);
        uint256 ledger0 = _ledger();
        vm.prank(alice);
        vm.expectRevert(IAgateSeries.NotOwnerOrOperator.selector);
        router.closeShort(address(s), _ids(r1[0], p2), 100 * U, _none());
        assertEq(dollar.balanceOf(alice), d0);
        assertEq(m.depthAt(true, 3_640_000), askDepth);
        assertEq(_ledger(), ledger0);
        assertEq(s.position(r1[0]).owner, alice);
        assertEq(s.position(p2).owner, alice);
        vm.prank(alice);
        s.setOperator(p2, address(router)); // the explicit per-position grant
        (uint256 paid,,) = _closeShort(alice, _ids(r1[0], p2), 100 * U);
        assertEq(paid, 20 * uint256(C));
    }

    /// Only this factory's series: a series of another factory (with its own router) is NotSeries here.
    function test_I33_onlyThisFactorysSeries() public {
        bytes32[] memory gpus = new bytes32[](1);
        gpus[0] = H100;
        string[] memory labels = new string[](1);
        labels[0] = "H100";
        IAgateFactory other = IAgateFactory(
            address(new AgateFactory(address(index), address(dollar), address(kuru), gpus, labels, admin, "demo", 0, 0))
        );
        address s2 = other.list(H100, NOV);
        other.createMarket(s2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NotSeries.selector, s2));
        router.openLong(s2, 364 * U, U, _none());
        assertTrue(other.router() != address(router));
        // the other factory's series trusts only its own router to open a SHORT position for someone else
        assertEq(IAgateSeries(s2).terms().router, other.router());
    }
}
