// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, Venue, Permit} from "../../../src/market/MarketTypes.sol";
import {MockIndex} from "../mocks/MockIndex.sol";

/// A KURU_V1-shaped market that fills a buy but delivers one base unit less than the minimum it was given, without
/// reverting: only the router's own measured check can stop it.
contract ShortChangingMarket {
    address internal immutable TOKEN;
    address internal immutable DOLLAR;

    constructor(address token_, address dollar_) {
        TOKEN = token_;
        DOLLAR = dollar_;
    }

    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        return (1_000_000, 10_000, TOKEN, 6, DOLLAR, 6, 10_000, 10_000, 10_000_000_000, 0, 0);
    }

    function marketState() external pure returns (uint8) {
        return 0;
    }

    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool, bool)
        external
        payable
        returns (uint256)
    {
        IERC20(DOLLAR).transferFrom(msg.sender, address(this), quoteSize);
        IERC20(TOKEN).transfer(msg.sender, minAmountOut - 1);
        return minAmountOut - 1;
    }
}

/// Independent conformance probes (audit, BUILD-SPEC 11 and 12.4). Not part of the main suite.
contract AuditConformanceTest is Test {
    bytes32 internal constant H100 = keccak256("H100-SXM/on-demand-list/neocloud/v1");
    bytes32 internal constant H200 = keccak256("H200-SXM/on-demand-list/neocloud/v1");
    uint32 internal constant NOV1 = 20_758;
    uint32 internal constant NOV = 2026 * 12 + 10;

    MockIndex internal ix;
    AgateDollar internal usd;
    AgateFactory internal fac;
    address internal admin = makeAddr("audit-admin");

    function setUp() public {
        ix = new MockIndex(86_400, 0, 0);
        ix.register(H100, keccak256("r"));
        for (uint32 d = 20_722; d < NOV1; ++d) {
            ix.put(H100, d, 3_600_000, uint64((uint256(d) + 1) * 86_400 + 21_600), IAgateIndex.Status.FULL, 5, false, false);
        }
        usd = new AgateDollar(address(this), 10_000 * U, 1 days);
        bytes32[] memory ids = new bytes32[](2);
        (ids[0], ids[1]) = (H100, H200); // H200 is in the label table but never registered at the index
        string[] memory labels = new string[](2);
        (labels[0], labels[1]) = ("H100", "H200");
        // the V2 pilot shape: no Kuru router, so the admin records the first market
        fac = new AgateFactory(address(ix), address(usd), address(0), ids, labels, admin, "pilot", 0, 0);
        vm.warp(uint256(NOV1) * 86_400 + 7 hours);
    }

    function _walk(address target) internal view returns (uint256 seen) {
        bytes memory code = target.code;
        uint256 end = code.length;
        if (end >= 2) {
            uint256 meta = (uint256(uint8(code[end - 2])) << 8) | uint8(code[end - 1]);
            if (meta + 2 <= end) end -= meta + 2;
        }
        // Only reachable bytes count: after a halting opcode nothing runs until the next JUMPDEST. via_ir puts
        // 32-byte constants (event topics, the guard's slot) after a final INVALID as data; the Routed topic holds
        // an 0xff byte there, which a plain walk misreads as SELFDESTRUCT.
        bool live = true;
        for (uint256 i; i < end; ++i) {
            uint8 op = uint8(code[i]);
            if (op == 0x5b) live = true;
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f;
                continue;
            }
            if (!live) continue;
            assertTrue(op != 0xf4, "DELEGATECALL");
            assertTrue(op != 0xf2, "CALLCODE");
            assertTrue(op != 0xff, "SELFDESTRUCT");
            ++seen;
            if (op == 0x00 || op == 0x56 || op == 0xf3 || op == 0xfd || op == 0xfe) live = false;
        }
    }

    /// The plain walk of series/Immutability.t.sol, applied to the router, reports a SELFDESTRUCT that is data.
    function test_audit_plainWalkMisreadsRouterData() public view {
        bytes memory code = fac.router().code;
        uint256 end = code.length - 2 - ((uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]));
        bool ffSeen;
        for (uint256 i; i < end; ++i) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f;
                continue;
            }
            if (op == 0xff) ffSeen = true;
        }
        assertTrue(ffSeen);
    }

    /// I15 names the factory and the router too; the main suite's opcode walk covers only the series and the token.
    function test_audit_I15_opcodeWalkFactoryAndRouter() public view {
        assertGt(_walk(address(fac)), 1_000);
        assertGt(_walk(fac.router()), 1_000);
    }

    /// Spec 3.3 checks only the label table for UnknownGpu; the model also requires the GPU at the index. A GPU in
    /// the label table that the index never registered therefore reverts NotReady here (UnknownGpu in the model).
    function test_audit_unknownAtTheIndexIsNotReady() public {
        vm.expectRevert(IAgateFactory.NotReady.selector);
        fac.list(H200, NOV);
        vm.expectRevert(IAgateFactory.NotReady.selector);
        fac.previewListing(H200, NOV);
    }

    /// 6.3 buy(): got must be >= minOut, else SlippageExceeded. No main-suite test reaches the router's own check (the
    /// mock book enforces minAmountOut first); a venue that under-delivers without reverting is stopped by it.
    function test_audit_routerSlippageCheckIsLive() public {
        IAgateSeries s = IAgateSeries(fac.list(H100, NOV));
        address token = s.token();
        ShortChangingMarket m = new ShortChangingMarket(token, address(usd));
        usd.mint(address(this), 1_000 * U);
        usd.approve(address(s), type(uint256).max);
        s.mint(10 * U, address(m)); // the market's inventory
        vm.prank(admin);
        fac.attachMarket(address(s), address(m), Venue.KURU_V1);
        address user = makeAddr("audit-user");
        usd.mint(user, 100 * U);
        IAgateRouter r = IAgateRouter(fac.router());
        Permit memory none;
        vm.startPrank(user);
        usd.approve(address(r), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.SlippageExceeded.selector, U - 1, U));
        r.openLong(address(s), 4 * U, U, none);
        vm.stopPrank();
    }
}
