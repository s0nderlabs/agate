// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, Side, Venue, Permit, Position} from "../../../src/market/MarketTypes.sol";
import {RouterBase} from "./RouterBase.sol";
import {NoPermitDollar, FeeOnTransferDollar} from "./RouterTokens.sol";

/// I25 (BUILD-SPEC 6.1, 6.2, finding F1): a standing allowance to the router is safe (it pulls only from msg.sender
/// inside a flow msg.sender started), so a third party moves nothing with a victim's allowance; every flow takes an
/// optional EIP-2612 permit (valid, front-run, bad, expired, a dollar without permit); the pull is measured
/// (PullInexact); after every flow the router holds nothing and every allowance it gave is 0.
contract RouterAllowanceTest is RouterBase {
    /// After one standing allowance per asset, every flow is one call; the router holds nothing after each.
    function test_I25_standingAllowanceThenOneCallPerFlow() public {
        _bookWorld();
        address u = _user("u", 100_000 * U);
        _long(u, 364 * U, 100 * U);
        _holdsNothing(0, 0);
        _closeLong(u, 100 * U, U);
        _holdsNothing(0, 0);
        (uint256[] memory sids,,) = _short(u, 100 * U, U, 1, u, true);
        _holdsNothing(0, 0);
        uint256[] memory lids = _longDaily(u, 364 * U, 100 * U, 1, u);
        _holdsNothing(0, 0);
        _closeShort(u, sids, 365 * U);
        _holdsNothing(0, 0);
        _closeLongDaily(u, lids, U);
        _holdsNothing(0, 0);
        // the user's standing allowances stay standing (OpenZeppelin v5: unlimited is never decreased)
        assertEq(dollar.allowance(u, address(router)), type(uint256).max);
        assertEq(token.allowance(u, address(router)), type(uint256).max);
    }

    /// A victim's max allowances to the router (dollar and token) and a SHORT position the router operates are in
    /// place; an attacker runs every flow, naming the victim wherever a parameter allows; the victim's dollars,
    /// tokens, short balance and position never move.
    function test_I25_thirdPartyMovesNothingWithAVictimsStandingAllowance() public {
        _bookWorld();
        address victim = _user("victim", 100_000 * U);
        vm.startPrank(victim);
        dollar.approve(address(s), type(uint256).max);
        s.mint(100 * U, victim);
        (uint256 vpid,) = s.streamOut(Side.SHORT, 50 * U, victim, victim, victim, true);
        s.setOperator(vpid, address(router));
        vm.stopPrank();
        (uint256[] memory vids,,) = _short(victim, 10 * U, U, 1, victim, true); // a router-opened one too
        uint256 vid = vids[0];
        bytes memory before = abi.encode(
            dollar.balanceOf(victim), token.balanceOf(victim), s.shortOf(victim), s.position(vpid), s.position(vid)
        );
        address x = _user("x", 100_000 * U);
        vm.startPrank(x);
        try router.openLong(address(s), 364 * U, 100 * U, _none()) {} catch {}
        try router.openLongDaily(address(s), 364 * U, 100 * U, 1, victim, _none()) {} catch {}
        try router.openShort(address(s), 100 * U, U, 1, victim, true, _none()) {} catch {}
        try router.closeLong(address(s), 100 * U, U, _none()) {} catch {}
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NotYourPosition.selector, vpid));
        router.closeShort(address(s), _ids(vpid), 400 * U, _none());
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NotYourPosition.selector, vid));
        router.closeShort(address(s), _ids(vid), 400 * U, _none());
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NotYourPosition.selector, vpid));
        router.closeLongDaily(address(s), _ids(vpid), U, _none());
        vm.stopPrank();
        bytes memory after_ = abi.encode(
            dollar.balanceOf(victim), token.balanceOf(victim), s.shortOf(victim), s.position(vpid), s.position(vid)
        );
        assertEq(keccak256(after_), keccak256(before));
        _holdsNothing(0, 0);
    }

    /// A fresh account (a faucet drip, no allowance at all): without a permit the pull fails; with a permit for
    /// exactly the amount the first click is one call and leaves no allowance; the token's permit does the same for
    /// closeLong.
    function test_permit_validMakesTheFirstClickOneCall() public {
        _bookWorld();
        (address fresh, uint256 key) = makeAddrAndKey("fresh");
        _give(fresh, 1_000 * U);
        vm.prank(fresh);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, 364 * U)
        );
        router.openLong(address(s), 364 * U, 100 * U, _none());
        uint256 dl = block.timestamp + 1 hours;
        Permit memory p = _sign(address(dollar), key, 364 * U, dl);
        vm.prank(fresh);
        assertEq(router.openLong(address(s), 364 * U, 100 * U, p), 100 * U);
        assertEq(dollar.allowance(fresh, address(router)), 0);
        Permit memory tp = _sign(address(token), key, 100 * U, dl);
        vm.prank(fresh);
        assertEq(router.closeLong(address(s), 100 * U, U, tp), 360 * U);
        assertEq(token.allowance(fresh, address(router)), 0);
        _holdsNothing(0, 0);
    }

    /// The app's default: the first click carries a permit for an unlimited standing amount; later clicks need none.
    function test_permit_firstClickSetsAStandingAllowance() public {
        _bookWorld();
        (address fresh, uint256 key) = makeAddrAndKey("fresh");
        _give(fresh, 10_000 * U);
        Permit memory p = _sign(address(dollar), key, type(uint256).max, block.timestamp + 1 hours);
        vm.prank(fresh);
        router.openLong(address(s), 364 * U, 100 * U, p);
        assertEq(dollar.allowance(fresh, address(router)), type(uint256).max);
        vm.prank(fresh);
        (uint256[] memory ids,,) = router.openShort(address(s), 100 * U, U, 1, fresh, true, _none());
        vm.prank(fresh);
        router.closeShort(address(s), ids, 365 * U, _none());
        _holdsNothing(0, 0);
    }

    /// Someone submits the permit first (it sets the allowance and burns the nonce): the router's own permit call
    /// fails, is ignored, and the flow works on the allowance already set.
    function test_permit_frontRunStillWorks() public {
        _bookWorld();
        (address fresh, uint256 key) = makeAddrAndKey("fresh");
        _give(fresh, 1_000 * U);
        Permit memory p = _sign(address(dollar), key, 364 * U, block.timestamp + 1 hours);
        vm.prank(makeAddr("griefer"));
        IERC20PermitLike(address(dollar)).permit(fresh, address(router), p.value, p.deadline, p.v, p.r, p.s);
        vm.prank(fresh);
        assertEq(router.openLong(address(s), 364 * U, 100 * U, p), 100 * U);
        _holdsNothing(0, 0);
    }

    /// A permit signed by another key, or one past its deadline, sets nothing: the pull fails on the allowance.
    function test_permit_badOrExpiredFailsOnTheAllowance() public {
        _bookWorld();
        (address fresh2,) = makeAddrAndKey("fresh2");
        (, uint256 otherKey) = makeAddrAndKey("fresh");
        _give(fresh2, 1_000 * U);
        Permit memory bad = _sign(address(dollar), otherKey, 364 * U, block.timestamp + 1 hours); // signed for fresh
        vm.prank(fresh2);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, 364 * U)
        );
        router.openLong(address(s), 364 * U, 100 * U, bad);
        (, uint256 key2) = makeAddrAndKey("fresh2");
        Permit memory late = _sign(address(dollar), key2, 364 * U, block.timestamp - 1);
        vm.prank(fresh2);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, 364 * U)
        );
        router.openLong(address(s), 364 * U, 100 * U, late);
        // the same signature with a valid deadline works
        Permit memory ok = _sign(address(dollar), key2, 364 * U, block.timestamp);
        vm.prank(fresh2);
        assertEq(router.openLong(address(s), 364 * U, 100 * U, ok), 100 * U);
    }

    /// A dollar without EIP-2612 (Kuru's testnet USDC shape): a permit argument is ignored; without an allowance
    /// the pull fails, with a standing allowance every flow works.
    function test_permit_dollarWithoutPermitUsesTheStandingAllowance() public {
        _world(address(new NoPermitDollar("usdc", "USDC")), 0, 0);
        _maker(10_000 * U);
        _ask(3_640_000, 1_000 * U);
        _bid(3_600_000, 1_000 * U);
        address u = makeAddr("u");
        _give(u, 10_000 * U);
        Permit memory junk = Permit(364 * U, block.timestamp + 1 hours, 27, keccak256("r"), keccak256("s"));
        vm.prank(u);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, 364 * U)
        );
        router.openLong(address(s), 364 * U, 100 * U, junk);
        vm.startPrank(u);
        dollar.approve(address(router), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        assertEq(router.openLong(address(s), 364 * U, 100 * U, junk), 100 * U);
        (uint256[] memory ids,,) = router.openShort(address(s), 100 * U, U, 1, u, true, junk);
        router.closeShort(address(s), ids, 365 * U, junk);
        router.closeLong(address(s), 100 * U, U, junk);
        vm.stopPrank();
        _holdsNothing(0, 0);
    }

    /// The pull is measured by the router's balance change: a dollar that skims transfers is refused (PullInexact).
    function test_pullInexact_feeOnTransferDollar() public {
        _world(address(new FeeOnTransferDollar()), 0, 0);
        address u = _user("u", 1_000 * U);
        vm.prank(u);
        vm.expectRevert(IAgateRouter.PullInexact.selector);
        router.openLong(address(s), 364 * U, U, _none());
        vm.prank(u);
        vm.expectRevert(IAgateRouter.PullInexact.selector);
        router.openShort(address(s), 10 * U, U, 1, u, true, _none());
    }

    /// The router approves exact amounts right before each call and resets them right after: nothing in between
    /// is visible after the call, on any flow, in any order.
    function test_I25_allowancesResetAfterEveryFlow() public {
        _bookWorld();
        address u = _user("u", 100_000 * U);
        for (uint256 i; i < 3; ++i) {
            (uint256[] memory sids,,) = _short(u, 30 * U, U, 3, u, i % 2 == 0);
            _holdsNothing(0, 0);
            uint256[] memory lids = _longDaily(u, 400 * U, 100 * U, 2, u);
            _holdsNothing(0, 0);
            _closeShort(u, sids, 200 * U);
            _holdsNothing(0, 0);
            _closeLongDaily(u, lids, U);
            _holdsNothing(0, 0);
        }
        // every position the user opened is closed; the user holds the off-grid remainders only
        for (uint256 id = 1; id < 20; ++id) {
            Position memory p = s.position(id);
            assertTrue(p.owner == address(0) || p.owner == mm, "a router position stayed open");
        }
    }

    /// The end-of-flow check is a real backstop: a market that leaves tokens with the router makes the flow revert
    /// RouterKeptSomething, so the router never ends a call holding anything (pilot-shape factory, admin-attached).
    function test_I25_routerRefusesToEndAFlowHoldingSomething() public {
        _world();
        bytes32[] memory gpus = new bytes32[](1);
        gpus[0] = H100;
        string[] memory labels = new string[](1);
        labels[0] = "H100";
        IAgateFactory pilot = IAgateFactory(
            address(new AgateFactory(address(index), address(dollar), address(0), gpus, labels, admin, "pilot", 0, 0))
        );
        address s2 = pilot.list(H100, NOV);
        address t2 = IAgateSeries(s2).token();
        HalfFillBook leaky = new HalfFillBook(t2, address(dollar));
        _give(address(leaky), 1_000 * U);
        vm.prank(admin);
        pilot.attachMarket(s2, address(leaky), Venue.KURU_V1);
        IAgateRouter r2 = IAgateRouter(pilot.router());
        address u = makeAddr("u");
        _give(u, 1_000 * U);
        vm.startPrank(u);
        dollar.approve(s2, type(uint256).max);
        IAgateSeries(s2).mint(100 * U, u);
        IERC20(t2).approve(address(r2), type(uint256).max);
        vm.expectRevert(IAgateRouter.RouterKeptSomething.selector);
        r2.closeLong(s2, 100 * U, U, _none());
        vm.stopPrank();
        assertEq(IERC20(t2).balanceOf(u), 100 * U);
        assertEq(IERC20(t2).balanceOf(address(r2)), 0);
    }
}

/// A market that answers the factory's KURU_V1 checks but ignores fill-or-kill: a sell takes half the size and pays
/// the minimum. The router must refuse to end the flow holding the rest (RouterKeptSomething), not keep it.
contract HalfFillBook {
    address internal immutable token;
    address internal immutable dollar;

    constructor(address token_, address dollar_) {
        token = token_;
        dollar = dollar_;
    }

    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        return (1e6, 1e4, token, 6, dollar, 6, 1e4, 1e4, 1e10, 0, 0);
    }

    function marketState() external pure returns (uint8) {
        return 0;
    }

    function placeAndExecuteMarketSell(uint96 size, uint256 minOut, bool, bool) external payable returns (uint256) {
        IERC20(token).transferFrom(msg.sender, address(this), uint256(size) * 100 / 2);
        IERC20(dollar).transfer(msg.sender, minOut);
        return minOut;
    }
}

interface IERC20PermitLike {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
