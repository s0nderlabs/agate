// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {IAgateDollar} from "../../../src/market/interfaces/IAgateDollar.sol";

/// I34 and BUILD-SPEC 5: the test dollar. At most one drip per address per dripPeriod; only the minter mints
/// otherwise; EIP-2612 permit with the domain "agate test dollar", version "1".
contract DollarTest is Test {
    AgateDollar internal usd;
    address internal minter = makeAddr("minter");
    uint256 internal constant DRIP = 10_000e6; // 10,000 tUSD
    uint64 internal constant PERIOD = 86_400;
    uint256 internal constant START = 1_790_000_000;

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public {
        vm.warp(START);
        usd = new AgateDollar(minter, DRIP, PERIOD);
    }

    function test_metadata() public view {
        assertEq(usd.name(), "agate test dollar");
        assertEq(usd.symbol(), "tUSD");
        assertEq(usd.decimals(), 6);
        assertEq(usd.minter(), minter);
        assertEq(usd.dripAmount(), DRIP);
        assertEq(usd.dripPeriod(), PERIOD);
        assertEq(usd.totalSupply(), 0);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("agate test dollar"),
                keccak256("1"),
                block.chainid,
                address(usd)
            )
        );
        assertEq(usd.DOMAIN_SEPARATOR(), domain);
    }

    function test_badInit() public {
        vm.expectRevert(IAgateDollar.BadInit.selector);
        new AgateDollar(address(0), DRIP, PERIOD);
        vm.expectRevert(IAgateDollar.BadInit.selector);
        new AgateDollar(minter, 0, PERIOD);
        vm.expectRevert(IAgateDollar.BadInit.selector);
        new AgateDollar(minter, DRIP, 0);
    }

    // ------------------------------------------------------------------ the faucet

    /// Model TestI34Faucet.test_rate_limit.
    function test_I34_rateLimit() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        uint256 t = START; // a constant: under via_ir a local copy of block.timestamp is re-read after vm.warp
        vm.expectEmit(true, false, false, true, address(usd));
        emit IAgateDollar.Dripped(a, DRIP, uint64(t + PERIOD));
        vm.prank(a);
        assertEq(usd.drip(), DRIP);
        assertEq(usd.nextDripAt(a), t + PERIOD);
        vm.warp(t + PERIOD - 1);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(IAgateDollar.DripTooSoon.selector, uint64(t + PERIOD)));
        usd.drip();
        vm.warp(t + PERIOD);
        vm.prank(a);
        usd.drip();
        vm.prank(b);
        usd.drip();
        assertEq(usd.balanceOf(a), 2 * DRIP);
        assertEq(usd.balanceOf(b), DRIP);
        vm.prank(a);
        vm.expectRevert(IAgateDollar.NotMinter.selector);
        usd.mint(a, 1);
        vm.prank(minter);
        usd.mint(makeAddr("bot"), 10 ** 13);
        assertEq(usd.totalSupply(), 3 * DRIP + 10 ** 13);
    }

    /// Any schedule of drip attempts by one address: a drip succeeds exactly when a period has passed since the
    /// last successful one, and the balance is DRIP times the successes.
    function testFuzz_I34_oneDripPerPeriod(uint256 seed) public {
        address a = makeAddr("dripper");
        uint256 now_ = START;
        uint256 last;
        bool any;
        uint256 ok;
        for (uint256 i; i < 24; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            now_ += seed % (PERIOD + PERIOD / 2);
            vm.warp(now_);
            bool due = !any || now_ >= last + PERIOD;
            vm.prank(a);
            try usd.drip() returns (uint256 amt) {
                assertTrue(due, "dripped too soon");
                assertEq(amt, DRIP);
                assertEq(usd.nextDripAt(a), now_ + PERIOD);
                last = now_;
                any = true;
                ++ok;
            } catch (bytes memory err) {
                assertFalse(due, "refused a due drip");
                assertEq(bytes4(err), IAgateDollar.DripTooSoon.selector);
            }
        }
        assertEq(usd.balanceOf(a), ok * DRIP);
        assertEq(usd.totalSupply(), ok * DRIP);
    }

    /// Only the minter mints besides the faucet.
    function testFuzz_I34_onlyMinterMints(address who, uint256 amount) public {
        vm.assume(who != minter && who != address(0)); // OpenZeppelin refuses a mint to address(0)
        amount = bound(amount, 1, 1e30);
        vm.prank(who);
        vm.expectRevert(IAgateDollar.NotMinter.selector);
        usd.mint(who, amount);
        vm.prank(minter);
        usd.mint(who, amount);
        assertEq(usd.balanceOf(who), amount);
    }

    /// A huge period saturates nextDripAt instead of overflowing: that address never drips again.
    function test_dripPeriodSaturates() public {
        AgateDollar d = new AgateDollar(minter, DRIP, type(uint64).max);
        address a = makeAddr("a");
        vm.prank(a);
        d.drip();
        assertEq(d.nextDripAt(a), type(uint64).max);
        vm.warp(START + 365 days * 1000);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(IAgateDollar.DripTooSoon.selector, type(uint64).max));
        d.drip();
    }

    // ------------------------------------------------------------------ permit (EIP-2612)

    /// pk signs a permit naming `owner` (a wrong signer when pk is not owner's key).
    function _sign(uint256 pk, address owner, address spender, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usd.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline))
            )
        );
        return vm.sign(pk, digest);
    }

    function test_permit() public {
        uint256 pk = 0xA11CE;
        address owner = vm.addr(pk);
        address router = makeAddr("router");
        uint256 deadline = START + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(pk, owner, router, type(uint256).max, 0, deadline);
        usd.permit(owner, router, type(uint256).max, deadline, v, r, s); // anyone may submit it
        assertEq(usd.allowance(owner, router), type(uint256).max);
        assertEq(usd.nonces(owner), 1);
        // a replay fails (the nonce moved)
        vm.expectRevert();
        usd.permit(owner, router, type(uint256).max, deadline, v, r, s);
        // the allowance works
        vm.prank(minter);
        usd.mint(owner, 5e6);
        vm.prank(router);
        usd.transferFrom(owner, router, 5e6);
        assertEq(usd.balanceOf(router), 5e6);
    }

    function test_permit_expiredOrWrongSigner() public {
        uint256 pk = 0xB0B;
        address owner = vm.addr(pk);
        address spender = makeAddr("spender");
        uint256 deadline = START + 10;
        (uint8 v, bytes32 r, bytes32 s) = _sign(pk, owner, spender, 100, 0, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612ExpiredSignature.selector, deadline));
        usd.permit(owner, spender, 100, deadline, v, r, s);
        vm.warp(deadline);
        (v, r, s) = _sign(0xBAD, owner, spender, 100, 0, deadline);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20Permit.ERC2612InvalidSigner.selector, vm.addr(0xBAD), owner)
        );
        usd.permit(owner, spender, 100, deadline, v, r, s);
        assertEq(usd.nonces(owner), 0);
    }
}
