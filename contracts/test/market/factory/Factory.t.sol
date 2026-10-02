// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {AgateRouter} from "../../../src/market/AgateRouter.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {FactoryBase} from "./FactoryBase.sol";

contract Dollar18 is ERC20("eighteen", "E18") {}

contract RevertingDecimals {
    function decimals() external pure returns (uint8) {
        revert("no");
    }
}

/// The factory's constructor checks (BUILD-SPEC 10.2), its router (3.5) and its views.
contract FactoryTest is FactoryBase {
    function setUp() public {
        _prodWorld();
    }

    function _deploy(
        address index_,
        address dollar_,
        bytes32[] memory ids,
        string[] memory labels,
        string memory tag,
        uint256 tf,
        uint256 mf
    ) internal returns (AgateFactory) {
        return new AgateFactory(index_, dollar_, address(kuru), ids, labels, admin, tag, tf, mf);
    }

    function _expectBadInit(
        address index_,
        address dollar_,
        bytes32[] memory ids,
        string[] memory labels,
        string memory tag,
        uint256 tf,
        uint256 mf
    ) internal {
        vm.expectRevert(IAgateFactory.BadInit.selector);
        _deploy(index_, dollar_, ids, labels, tag, tf, mf);
    }

    function _one(bytes32 id, string memory label) internal pure returns (bytes32[] memory ids, string[] memory l) {
        ids = new bytes32[](1);
        l = new string[](1);
        ids[0] = id;
        l[0] = label;
    }

    // ------------------------------------------------------------------ the router (3.5)

    function test_routerDeployedInConstructor() public view {
        address r = f.router();
        assertGt(r.code.length, 0);
        assertEq(IAgateRouter(r).factory(), address(f));
        assertEq(r, vm.computeCreateAddress(address(f), 1), "the factory's first CREATE");
    }

    function test_eachFactoryItsOwnRouter() public {
        AgateFactory g = _factory("pilot", address(0), 0, 0);
        assertTrue(g.router() != f.router());
        assertEq(AgateRouter(g.router()).factory(), address(g));
    }

    // ------------------------------------------------------------------ constructor checks (10.2)

    function test_badInit_addresses() public {
        (bytes32[] memory ids, string[] memory labels) = _gpus();
        _expectBadInit(address(0), address(usd), ids, labels, "", 0, 0);
        _expectBadInit(address(ix), address(0), ids, labels, "", 0, 0);
        _expectBadInit(address(ix), makeAddr("eoa"), ids, labels, "", 0, 0); // no code: not 6 decimals
        _expectBadInit(address(ix), address(new Dollar18()), ids, labels, "", 0, 0);
        _expectBadInit(address(ix), address(new RevertingDecimals()), ids, labels, "", 0, 0);
    }

    function test_badInit_gpus() public {
        (bytes32[] memory ids, string[] memory labels) = _gpus();
        _expectBadInit(address(ix), address(usd), new bytes32[](0), new string[](0), "", 0, 0);
        string[] memory two = new string[](2);
        (two[0], two[1]) = ("H100", "H200");
        _expectBadInit(address(ix), address(usd), ids, two, "", 0, 0); // lengths differ
        bytes32[] memory nine = new bytes32[](9);
        string[] memory nineL = new string[](9);
        for (uint256 i; i < 9; ++i) {
            nine[i] = bytes32(i + 1);
            nineL[i] = "G";
        }
        _expectBadInit(address(ix), address(usd), nine, nineL, "", 0, 0);
        bytes32[] memory eight = new bytes32[](8);
        string[] memory eightL = new string[](8);
        for (uint256 i; i < 8; ++i) {
            eight[i] = bytes32(i + 1);
            eightL[i] = "G";
        }
        _deploy(address(ix), address(usd), eight, eightL, "", 0, 0); // eight is fine
        ids[2] = ids[0]; // duplicate gpuId
        _expectBadInit(address(ix), address(usd), ids, labels, "", 0, 0);
        string[4] memory bad = ["", "H 100", "ABCDEFGHI", "H\x01"];
        for (uint256 i; i < bad.length; ++i) {
            (bytes32[] memory i1, string[] memory l1) = _one(H100, bad[i]);
            _expectBadInit(address(ix), address(usd), i1, l1, "", 0, 0);
        }
    }

    /// Model test_any_tag_prefixes_the_symbol: a tag is "" or 1 to 8 letters a to z.
    function test_badInit_tag() public {
        (bytes32[] memory ids, string[] memory labels) = _gpus();
        string[5] memory bad = ["Demo", "pilot1", "a b", "abcdefghi", "-"];
        for (uint256 i; i < bad.length; ++i) {
            _expectBadInit(address(ix), address(usd), ids, labels, bad[i], 0, 0);
        }
        string[5] memory good = ["", "p", "demo", "pilot", "abcdefgh"];
        for (uint256 i; i < good.length; ++i) {
            assertEq(_deploy(address(ix), address(usd), ids, labels, good[i], 0, 0).tag(), good[i]);
        }
    }

    /// Model test_fees_are_factory_arguments: makerFeeBps <= takerFeeBps < 10,000.
    function test_badInit_fees() public {
        (bytes32[] memory ids, string[] memory labels) = _gpus();
        _expectBadInit(address(ix), address(usd), ids, labels, "", 10, 30);
        _expectBadInit(address(ix), address(usd), ids, labels, "", 10_000, 0);
        _expectBadInit(address(ix), address(usd), ids, labels, "", 10_000, 10_000);
        AgateFactory g = _deploy(address(ix), address(usd), ids, labels, "", 30, 10);
        assertEq(g.takerFeeBps(), 30);
        assertEq(g.makerFeeBps(), 10);
        _deploy(address(ix), address(usd), ids, labels, "", 9_999, 9_999);
    }

    function testFuzz_feesRule(uint256 tf, uint256 mf) public {
        tf = bound(tf, 0, 20_000);
        mf = bound(mf, 0, 20_000);
        (bytes32[] memory ids, string[] memory labels) = _gpus();
        if (mf <= tf && tf < 10_000) {
            _deploy(address(ix), address(usd), ids, labels, "", tf, mf);
        } else {
            _expectBadInit(address(ix), address(usd), ids, labels, "", tf, mf);
        }
    }

    /// kuruRouter and marketAdmin may be zero (no V1 creation, no attach).
    function test_zeroKuruAndAdminAllowed() public {
        (bytes32[] memory ids, string[] memory labels) = _gpus();
        AgateFactory g = new AgateFactory(address(ix), address(usd), address(0), ids, labels, address(0), "", 0, 0);
        assertEq(g.kuruRouter(), address(0));
        assertEq(g.marketAdmin(), address(0));
    }

    // ------------------------------------------------------------------ views

    function test_views() public view {
        assertEq(f.index(), address(ix));
        assertEq(f.dollar(), address(usd));
        assertEq(f.kuruRouter(), address(kuru));
        assertEq(f.marketAdmin(), admin);
        assertEq(f.tag(), "");
        assertEq(f.takerFeeBps(), 0);
        assertEq(f.makerFeeBps(), 0);
        bytes32[] memory ids = f.gpuIds();
        assertEq(ids.length, 3);
        assertEq(ids[0], H100);
        assertEq(ids[1], H200);
        assertEq(ids[2], B200);
        assertEq(f.labelOf(H100), "H100");
        assertEq(f.labelOf(B200), "B200");
        assertEq(f.labelOf(keccak256("none")), "");
        assertEq(f.seriesOf(H100, NOV), address(0));
        assertFalse(f.isSeries(address(this)));
        (address m, ) = f.marketOf(address(this));
        assertEq(m, address(0));
        assertFalse(f.routerCanUse(address(this)));
    }

    function test_currentMonth_bothClocks() public {
        _at(uint256(NOV1) * 86_400 - 1);
        assertEq(f.currentMonth(), OCT);
        _at(uint256(NOV1) * 86_400);
        assertEq(f.currentMonth(), NOV);
        _demoWorld();
        _at(T0);
        assertEq(f.currentMonth(), OCT);
        _at(T0 + 31 * 600 - 1);
        assertEq(f.currentMonth(), OCT);
        _at(T0 + 31 * 600);
        assertEq(f.currentMonth(), NOV);
        _at(T0 - 1_000); // before the epoch the index says epochDay
        assertEq(f.currentMonth(), OCT);
    }

    /// The factory has no owner and no admin function besides attachMarket (I15, factory part).
    function test_noOwnerFunctions() public {
        (bool ok,) = address(f).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok);
        (ok,) = address(f).call(abi.encodeWithSignature("transferOwnership(address)", address(this)));
        assertFalse(ok);
    }
}
