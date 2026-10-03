// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Permit} from "../../../src/market/MarketTypes.sol";
import {RouterBase} from "../router/RouterBase.sol";

interface IHookReceiver {
    function onDollar() external;
}

/// A 6-decimal dollar with an ERC777-style receive hook (the dollar is a deploy setting, BUILD-SPEC 5).
contract HookDollar is ERC20 {
    mapping(address => bool) public hooked;

    constructor() ERC20("hook dollar", "HOOK") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address who, bool on) external {
        hooked[who] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && hooked[to]) IHookReceiver(to).onDollar();
    }
}

/// A user contract that, whenever it receives dollars in the middle of a router flow, tries to re-enter the router
/// and the series, records what happened and carries on.
contract HookUser is IHookReceiver {
    IAgateRouter internal immutable r;
    IAgateSeries internal immutable s;
    IERC20 internal immutable usd;
    IERC20 internal immutable tok;
    bool internal armed;
    uint256 public hooks;
    // per hook (1 = while the series pays the floor, 2 = on the router's refund): did the re-entry succeed?
    mapping(uint256 => bool) public routerOk;
    mapping(uint256 => bool) public claimOk;
    mapping(uint256 => bool) public mintOk;

    constructor(IAgateRouter r_, IAgateSeries s_, IERC20 usd_) {
        r = r_;
        s = s_;
        usd = usd_;
        tok = IERC20(s_.token());
        usd_.approve(address(r_), type(uint256).max);
        usd_.approve(address(s_), type(uint256).max);
        tok.approve(address(r_), type(uint256).max);
    }

    function openLongDaily(uint256 din, uint256 minOut) external returns (uint256[] memory ids) {
        armed = true;
        ids = r.openLongDaily(address(s), din, minOut, 1, address(this), Permit(0, 0, 0, 0, 0));
        armed = false;
    }

    function onDollar() external {
        if (!armed) return;
        armed = false; // one level of re-entry per hook
        uint256 h = ++hooks;
        Permit memory none;
        (bool ok,) = address(r).call(abi.encodeCall(IAgateRouter.closeLong, (address(s), LOT, 1, none)));
        routerOk[h] = ok;
        uint256[] memory one = new uint256[](1);
        one[0] = 1;
        (ok,) = address(s).call(abi.encodeCall(IAgateSeries.claimMany, (one)));
        claimOk[h] = ok;
        (ok,) = address(s).call(abi.encodeCall(IAgateSeries.mint, (LOT, address(this))));
        mintOk[h] = ok;
        armed = true;
    }
}

/// Security audit: cross-contract reentry through a dollar with a receive hook, during router flows. The router and
/// the series each hold their own transient guard; a hook that fires while the series pays (floor of a LONG
/// position) finds both locked; a hook that fires on the router's own refund finds only the router locked, so it may
/// use the series directly with its own money, which changes nothing the router checks. Money stays whole: the
/// series' balance equals its ledger and the router holds nothing. Passes on the current code (no finding).
contract HookDollarReentryTest is RouterBase {
    function test_audit_hookDollarCannotReenterAndCannotCreateMoney() public {
        HookDollar hd = new HookDollar();
        _world(address(hd), 0, 0);
        _maker(50_000 * U);
        _ask(3_640_000, 500 * U); // a thin book, so the buy leaves unused quote to refund
        _bid(3_600_000, 5_000 * U);

        HookUser hu = new HookUser(router, s, dollar);
        _give(address(hu), 10_000 * U);
        hd.setHook(address(hu), true);

        // 3,700 dollars for at least 400 tokens: the floor is paid by the series (both locked), then the router
        // refunds the unused quote, 3,700 - 500 x 3.64 = 1,880 dollars (only the router locked)
        uint256[] memory ids = hu.openLongDaily(3_700 * U, 400 * U);
        assertEq(ids.length, 1);
        assertEq(hu.hooks(), 2, "the hook fired on the floor and on the refund");
        assertFalse(hu.routerOk(1), "router guard held while the series paid");
        assertFalse(hu.claimOk(1), "series guard held while the series paid");
        assertFalse(hu.mintOk(1), "series guard held while the series paid");
        assertFalse(hu.routerOk(2), "router guard held on the refund");
        assertTrue(hu.claimOk(2), "on the refund the series is free: a claim of the user's own position");
        assertTrue(hu.mintOk(2), "on the refund the series is free: a mint with the user's own money");

        _holdsNothing(0, 0);
        assertEq(dollar.balanceOf(address(s)), _ledger(), "the series' balance is its ledger");
        // the one direct mint made from inside the refund hook, with the user's own dollars
        assertEq(s.shortOf(address(hu)), LOT);
    }
}
