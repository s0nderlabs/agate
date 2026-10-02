// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {AgateDollar} from "../../../../src/market/AgateDollar.sol";
import {AgateFactory} from "../../../../src/market/AgateFactory.sol";
import {AgateRouter} from "../../../../src/market/AgateRouter.sol";
import {IAgateFactory} from "../../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateRouter} from "../../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Venue, Permit, Position} from "../../../../src/market/MarketTypes.sol";
import {MockKuruOrderBook} from "../../mocks/MockKuruOrderBook.sol";
import {RouterBase} from "../../router/RouterBase.sol";

/// A factory that lies: every address is its series and every series trades on the given market.
contract LyingFactory {
    address internal immutable mk;

    constructor(address market_) {
        mk = market_;
    }

    function isSeries(address) external pure returns (bool) {
        return true;
    }

    function marketOf(address) external view returns (address, Venue) {
        return (mk, Venue.KURU_V1);
    }
}

/// Cold recheck r1, router authority and permits.
contract RecheckRouterTest is RouterBase {
    function _gpus() internal pure returns (bytes32[] memory gpus, string[] memory labels) {
        gpus = new bytes32[](2);
        (gpus[0], gpus[1]) = (H100, H200);
        labels = new string[](2);
        (labels[0], labels[1]) = ("H100", "H200");
    }

    function _signFor(address asset, uint256 key, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (Permit memory p)
    {
        address owner = vm.addr(key);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, IERC20Permit(asset).nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC20Permit(asset).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(key, digest);
        p = Permit(value, deadline, v, r, ss);
    }

    /// The series' short guard does not depend on the router's code: a copy of the router pointed at a lying
    /// factory (any address is a series, our real market is its market) cannot turn the short units it minted into
    /// its caller's position, and neither it nor any other contract can close, re-operate or unstream a position the
    /// real router opened for someone else. The failed flow moves no money.
    function test_RC7_aRouterCopyOverALyingFactoryGetsNoShortAuthority() public {
        _bookWorld();
        AgateRouter copy = new AgateRouter(IAgateFactory(address(new LyingFactory(address(m)))), dollarAddr);
        address eve = _user("eve", 100_000 * U);
        vm.prank(eve);
        dollar.approve(address(copy), type(uint256).max);

        vm.prank(eve);
        vm.expectRevert(IAgateSeries.BadOwner.selector);
        copy.openShort(address(s), 720 * U, 1, 1, eve, true, _none());
        assertEq(dollar.balanceOf(eve), 100_000 * U, "the failed flow moved nothing");
        assertEq(s.shortOf(address(copy)), 0);

        address alice = _user("alice", 100_000 * U);
        (uint256[] memory ids,,) = _short(alice, 720 * U, 1, 1, alice, true);
        Position memory p0 = s.position(ids[0]);
        assertEq(p0.operator, address(router));

        vm.startPrank(address(copy));
        vm.expectRevert(IAgateSeries.NotOwnerOrOperator.selector);
        s.closeWithToken(ids[0], alice);
        vm.expectRevert(IAgateSeries.NotOwner.selector);
        s.setOperator(ids[0], address(copy));
        vm.expectRevert(IAgateSeries.NotOwner.selector);
        s.unstream(ids[0], alice);
        vm.expectRevert(IAgateSeries.NotOwner.selector);
        s.setPayout(ids[0], address(copy), true);
        vm.stopPrank();

        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NotYourPosition.selector, ids[0]));
        copy.closeShort(address(s), ids, 10_000 * U, _none());

        Position memory p1 = s.position(ids[0]);
        assertEq(p1.owner, alice);
        assertEq(p1.payee, alice);
        assertEq(p1.operator, address(router));
        assertEq(p1.paid, p0.paid);
        _holdsNothing(0, 0);
    }

    /// A permit names its spender: one signed for this factory's router is useless on another factory's router over
    /// the same dollar (the pull fails, the nonce is not spent), and still works where it was meant.
    function test_RC8_aPermitForOneRouterIsUselessOnAnother() public {
        _bookWorld();
        (bytes32[] memory gpus, string[] memory labels) = _gpus();
        AgateFactory f2 = new AgateFactory(address(index), dollarAddr, address(kuru), gpus, labels, admin, "demo", 0, 0);
        IAgateRouter r2 = IAgateRouter(f2.router());
        address s2 = f2.list(H100, NOV);
        f2.createMarket(s2);

        uint256 key = 0xA11CE;
        address u = vm.addr(key);
        _give(u, 10_000 * U);
        Permit memory p = _sign(dollarAddr, key, type(uint256).max, block.timestamp + 1 hours); // for `router`

        vm.prank(u);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(r2), 0, 3_640 * U)
        );
        r2.openLong(s2, 3_640 * U, 1, p);
        assertEq(IERC20Permit(dollarAddr).nonces(u), 0, "the permit was not used");
        assertEq(dollar.allowance(u, address(r2)), 0);
        assertEq(dollar.balanceOf(u), 10_000 * U);

        vm.prank(u);
        assertEq(router.openLong(address(s), 3_640 * U, 1_000 * U, p), 1_000 * U, "still good for its own router");
        assertEq(IERC20Permit(dollarAddr).nonces(u), 1);
        assertEq(dollar.allowance(u, address(r2)), 0);
        _holdsNothing(0, 0);
    }

    /// A flow that reverts after its permit (here at the market's minimum out) takes the permit with it: the nonce
    /// is unspent, no allowance is left, and the same signature works on the retry.
    function test_RC9_aRevertedFlowLeavesThePermitUnused() public {
        _bookWorld();
        uint256 key = 0xB0B;
        address u = vm.addr(key);
        _give(u, 10_000 * U);
        Permit memory p = _sign(dollarAddr, key, 5_000 * U, block.timestamp + 1 hours);

        vm.prank(u);
        vm.expectRevert(MockKuruOrderBook.SlippageExceeded.selector); // 3,640 buys 1,000 at 3.64, not 1,001
        router.openLong(address(s), 3_640 * U, 1_001 * U, p);
        assertEq(IERC20Permit(dollarAddr).nonces(u), 0);
        assertEq(dollar.allowance(u, address(router)), 0);
        assertEq(dollar.balanceOf(u), 10_000 * U);

        vm.prank(u);
        assertEq(router.openLong(address(s), 3_640 * U, 1_000 * U, p), 1_000 * U);
        assertEq(IERC20Permit(dollarAddr).nonces(u), 1);
        assertEq(dollar.allowance(u, address(router)), 1_360 * U, "the permit's amount minus the pull");
        _holdsNothing(0, 0);
    }

    /// Two factories with the same tag mint tokens with the same name and symbol (the deploy script refuses that
    /// config, the contracts do not): a token permit signed on one token's domain, for the other factory's router,
    /// does nothing on the other token; only the address in the EIP-712 domain tells them apart, and it is enough.
    function test_RC10_aTokenPermitDoesNotCarryToASameNamedToken() public {
        _bookWorld();
        (bytes32[] memory gpus, string[] memory labels) = _gpus();
        AgateDollar d2 = new AgateDollar(address(this), 10_000 * U, 86_400);
        AgateFactory f2 = new AgateFactory(address(index), address(d2), address(kuru), gpus, labels, admin, "", 0, 0);
        IAgateRouter r2 = IAgateRouter(f2.router());
        IAgateSeries s2 = IAgateSeries(f2.list(H100, NOV));
        f2.createMarket(address(s2));
        (address m2,) = f2.marketOf(address(s2));
        address t2 = s2.token();
        assertEq(IERC20Metadata(t2).name(), IERC20Metadata(address(token)).name(), "same name");
        assertEq(IERC20Metadata(t2).symbol(), IERC20Metadata(address(token)).symbol(), "same symbol");
        assertTrue(IERC20Permit(t2).DOMAIN_SEPARATOR() != IERC20Permit(address(token)).DOMAIN_SEPARATOR());

        uint256 key = 0xCAFE;
        address u = vm.addr(key);
        d2.mint(u, 720 * U);
        vm.startPrank(u);
        d2.approve(address(s2), type(uint256).max);
        s2.mint(100 * U, u);
        vm.stopPrank();
        d2.mint(mm, 1e12);
        vm.startPrank(mm);
        d2.approve(m2, type(uint256).max);
        MockKuruOrderBook(m2).addBuyOrder(3_600_000, uint96(1_000 * U / LOT), false);
        vm.stopPrank();

        Permit memory wrong = _signFor(address(token), key, address(r2), 100 * U, block.timestamp + 1 hours);
        vm.prank(u);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(r2), 0, 100 * U)
        );
        r2.closeLong(address(s2), 100 * U, 1, wrong);
        assertEq(IERC20Permit(t2).nonces(u), 0);
        assertEq(IERC20Permit(address(token)).nonces(u), 0);

        Permit memory right = _signFor(t2, key, address(r2), 100 * U, block.timestamp + 1 hours);
        vm.prank(u);
        assertEq(r2.closeLong(address(s2), 100 * U, 1, right), 360 * U);
        assertEq(IERC20(t2).balanceOf(u), 0);
        assertEq(IERC20Permit(t2).nonces(u), 1);
    }
}
