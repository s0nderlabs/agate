// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {Venue} from "../../../src/market/MarketTypes.sol";
import {DeployMarket} from "../../../script/DeployMarket.s.sol";
import {ListSeries} from "../../../script/ListSeries.s.sol";
import {MockIndex} from "../mocks/MockIndex.sol";
import {KuruRouterStub} from "../mocks/KuruRouterStub.sol";

/// BUILD-SPEC 10.3: DeployMarket and ListSeries run in-process (the same code a forge script runs), writing
/// throwaway deployments files under cache/test-deployments/ (gitignored, never next to the real deployments files;
/// v3.3). The run against a local anvil through anvil-safe is the command line of the script's header.
contract DeployScriptsTest is Test {
    DeployMarket internal dm;
    ListSeries internal ls;
    MockIndex internal demoIx;
    MockIndex internal realIx;
    KuruRouterStub internal kuru;
    AgateDollar internal usdc; // a 6-decimal stand-in for Kuru's testnet USDC
    address internal deployer = makeAddr("deployer");
    address internal bot = makeAddr("bot");
    string internal path;
    string internal pending;

    bytes32 internal constant H100 = 0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955;
    bytes32 internal constant H200 = 0xf7b3c4797305bd1433be196119ae5d6df4a433cffbf8d02c22048cc3a487b30d;
    bytes32 internal constant B200 = 0x0a5bf357b491308f9e8b00f22d9d58b1c984046be5b4a94a21a59038b996dd27;
    uint64 internal constant T0 = 1_800_000_000;
    uint32 internal constant OCT1 = 20_727;

    function setUp() public {
        vm.warp(T0);
        dm = new DeployMarket();
        ls = new ListSeries();
        demoIx = new MockIndex(600, T0, OCT1);
        realIx = new MockIndex(86_400, 0, 0);
        kuru = new KuruRouterStub();
        usdc = new AgateDollar(makeAddr("circle"), 1, 1);
    }

    /// Tests run in parallel: each gets its own throwaway file (and its pending twin), outside deployments/.
    function _use(string memory name) internal {
        string memory dir = string.concat(vm.projectRoot(), "/cache/test-deployments");
        vm.createDir(dir, true);
        path = string.concat(dir, "/.test-B-", name, ".json");
        pending = string.concat(path, ".pending");
        _cleanup();
    }

    function _q(address a) internal pure returns (string memory) {
        return string.concat('"', vm.toString(a), '"');
    }

    function _config(string memory factories, address dollar) internal view returns (string memory) {
        return string.concat(
            '{"chainId":31337,"dollar":{"address":',
            _q(dollar),
            ',"minter":',
            _q(deployer),
            ',"dripAmount":10000000000,"dripPeriod":86400},"botFloat":{"to":',
            _q(bot),
            ',"amount":10000000000000},"kuru":{"router":',
            _q(address(kuru)),
            ',"marginAccount":"0xd029C2D98ff85D8F64799017fE00a59B1159CE02","takerFeeBps":0,"makerFeeBps":0},',
            '"marketAdmin":',
            _q(deployer),
            ',"factories":[',
            factories,
            '],"gpus":[{"label":"H100","gpuId":"',
            vm.toString(H100),
            '"},{"label":"H200","gpuId":"',
            vm.toString(H200),
            '"},{"label":"B200","gpuId":"',
            vm.toString(B200),
            '"}]}'
        );
    }

    function _entry(string memory name, address index, string memory tag) internal pure returns (string memory) {
        return string.concat('{"name":"', name, '","index":', _q(index), ',"tag":"', tag, '"}');
    }

    function _pilot(bool enabled) internal view returns (string memory) {
        return string.concat(
            '{"name":"pilot","index":',
            _q(address(realIx)),
            ',"tag":"pilot","enabled":',
            enabled ? "true" : "false",
            ',"dollar":',
            _q(address(usdc)),
            ',"kuruRouter":"0x0000000000000000000000000000000000000000"}'
        );
    }

    function _three(bool pilotOn) internal view returns (string memory) {
        return string.concat(_entry("demo", address(demoIx), "demo"), ",", _entry("real", address(realIx), ""), ",", _pilot(pilotOn));
    }

    function _cleanup() internal {
        if (vm.exists(path)) vm.removeFile(path);
        if (vm.exists(pending)) vm.removeFile(pending);
    }

    // ------------------------------------------------------------------ DeployMarket

    function test_deploy_writesTheDeploymentsFile() public {
        _use("test_deploy_writesTheDeploymentsFile");
        DeployMarket.Plan memory p = dm.deploy(_config(_three(false), address(0)), path, true, deployer);
        // the script's run is only a plan until verify() finds every address on the chain (v3.3)
        assertFalse(vm.exists(path), "nothing in the deployments file before verify");
        assertTrue(vm.exists(pending));
        dm.verifyDeployments(path);
        assertFalse(vm.exists(pending));
        assertTrue(p.dollarFresh);
        assertEq(AgateDollar(p.dollar).minter(), deployer);
        assertEq(AgateDollar(p.dollar).balanceOf(bot), 10_000_000e6, "the bot float");
        assertEq(AgateDollar(p.dollar).dripAmount(), 10_000e6);
        assertEq(p.factories[2], address(0), "pilot disabled");

        string memory j = vm.readFile(path);
        assertEq(vm.parseJsonUint(j, ".chainId"), 31337);
        assertEq(vm.parseJsonAddress(j, ".dollar"), p.dollar);
        assertEq(vm.parseJsonAddress(j, ".kuru.router"), address(kuru));
        assertEq(vm.parseJsonAddress(j, ".kuru.marginAccount"), 0xd029C2D98ff85D8F64799017fE00a59B1159CE02);
        assertFalse(vm.keyExistsJson(j, ".factories.pilot"));
        string[2] memory names = ["demo", "real"];
        address[2] memory idx = [address(demoIx), address(realIx)];
        for (uint256 i; i < 2; ++i) {
            string memory k = string.concat(".factories.", names[i]);
            AgateFactory f = AgateFactory(vm.parseJsonAddress(j, string.concat(k, ".factory")));
            assertEq(address(f), p.factories[i]);
            assertEq(vm.parseJsonAddress(j, string.concat(k, ".router")), f.router());
            assertEq(vm.parseJsonAddress(j, string.concat(k, ".index")), idx[i]);
            assertEq(vm.parseJsonAddress(j, string.concat(k, ".dollar")), p.dollar);
            assertEq(vm.parseJsonString(j, string.concat(k, ".tag")), i == 0 ? "demo" : "");
            assertEq(vm.parseJsonUint(j, string.concat(k, ".tPend")), IAgateIndex(idx[i]).clocks().tPend);
            assertEq(vm.parseJsonUint(j, string.concat(k, ".startBlock")), block.number);
            assertEq(f.index(), idx[i]);
            assertEq(f.dollar(), p.dollar);
            assertEq(f.kuruRouter(), address(kuru));
            assertEq(f.marketAdmin(), deployer);
            assertEq(f.gpuIds().length, 3);
            assertEq(f.labelOf(B200), "B200");
        }
        assertEq(AgateFactory(p.factories[0]).tag(), "demo");
        _cleanup();
    }

    /// Idempotent: a second run reuses every address with code, mints no second float, and keeps keys it does
    /// not own; enabling the pilot later adds a third factory with its own dollar and no Kuru router.
    function test_deploy_idempotentAndMerging() public {
        _use("test_deploy_idempotentAndMerging");
        DeployMarket.Plan memory a = dm.deploy(_config(_three(false), address(0)), path, true, deployer);
        dm.verifyDeployments(path);
        vm.writeJson('"keep me"', path, ".note");
        vm.writeJson("7", path, ".factories.demo.extra");
        vm.roll(block.number + 100);
        DeployMarket.Plan memory b = dm.deploy(_config(_three(true), address(0)), path, true, deployer);
        dm.verifyDeployments(path);
        assertEq(b.dollar, a.dollar);
        assertFalse(b.dollarFresh);
        assertEq(b.factories[0], a.factories[0]);
        assertEq(b.factories[1], a.factories[1]);
        assertEq(AgateDollar(a.dollar).balanceOf(bot), 10_000_000e6, "no second float");
        string memory j = vm.readFile(path);
        assertEq(vm.parseJsonString(j, ".note"), "keep me");
        assertEq(vm.parseJsonUint(j, ".factories.demo.extra"), 7);
        assertEq(vm.parseJsonUint(j, ".factories.demo.startBlock"), block.number - 100, "a reused startBlock stays");
        AgateFactory pilot = AgateFactory(vm.parseJsonAddress(j, ".factories.pilot.factory"));
        assertEq(address(pilot), b.factories[2]);
        assertEq(pilot.dollar(), address(usdc));
        assertEq(pilot.kuruRouter(), address(0));
        assertEq(pilot.index(), address(realIx));
        assertEq(pilot.tag(), "pilot");
        assertEq(vm.parseJsonAddress(j, ".factories.pilot.dollar"), address(usdc));
        assertEq(vm.parseJsonUint(j, ".factories.pilot.startBlock"), block.number);
        // a third run changes nothing
        DeployMarket.Plan memory c = dm.deploy(_config(_three(true), address(0)), path, true, deployer);
        assertEq(c.factories[2], b.factories[2]);
        _cleanup();
    }

    function test_deploy_existingDollar() public {
        _use("test_deploy_existingDollar");
        DeployMarket.Plan memory p = dm.deploy(_config(_entry("real", address(realIx), ""), address(usdc)), path, true, deployer);
        assertEq(p.dollar, address(usdc));
        assertFalse(p.dollarFresh);
        assertEq(usdc.balanceOf(bot), 0, "no float in someone else's dollar");
        assertEq(AgateFactory(p.factories[0]).dollar(), address(usdc));
        _cleanup();
    }

    function test_deploy_dryRunWritesNothing() public {
        _use("test_deploy_dryRunWritesNothing");
        dm.deploy(_config(_three(false), address(0)), path, false, deployer);
        assertFalse(vm.exists(path));
        assertFalse(vm.exists(pending));
    }

    function test_deploy_refusesClashes() public {
        _use("test_deploy_refusesClashes");
        // the same (index, dollar) twice
        string memory twice = string.concat(_entry("demo", address(demoIx), "demo"), ",", _entry("demo2", address(demoIx), "x"));
        vm.expectRevert(bytes("two factories share (index, dollar): demo, demo2"));
        dm.deploy(_config(twice, address(0)), path, true, deployer);
        // the same symbol prefix ("demo" and "dev" both give d)
        string memory prefix = string.concat(_entry("demo", address(demoIx), "demo"), ",", _entry("dev", address(realIx), "dev"));
        vm.expectRevert(bytes("two factories share a symbol prefix: demo, dev"));
        dm.deploy(_config(prefix, address(0)), path, true, deployer);
        // the same name twice
        string memory dup = string.concat(_entry("demo", address(demoIx), "demo"), ",", _entry("demo", address(realIx), ""));
        vm.expectRevert(bytes("duplicate factory name: demo"));
        dm.deploy(_config(dup, address(0)), path, true, deployer);
        // an enabled entry whose index has no code (the testnet placeholders)
        vm.expectRevert(bytes("index has no code: real"));
        dm.deploy(_config(_entry("real", address(0), ""), address(0)), path, true, deployer);
        assertFalse(vm.exists(path));
        assertFalse(vm.exists(pending));
    }

    /// A factory already in the deployments file under another name counts too.
    function test_deploy_refusesClashWithTheFile() public {
        _use("test_deploy_refusesClashWithTheFile");
        dm.deploy(_config(_entry("demo", address(demoIx), "demo"), address(0)), path, true, deployer);
        dm.verifyDeployments(path);
        string memory other = _entry("dee", address(realIx), "dee");
        vm.expectRevert(bytes("two factories share a symbol prefix: dee, demo"));
        dm.deploy(_config(other, address(0)), path, true, deployer);
        _cleanup();
    }

    function test_deploy_refusesChangedSettings() public {
        _use("test_deploy_refusesChangedSettings");
        dm.deploy(_config(_entry("demo", address(demoIx), "demo"), address(0)), path, true, deployer);
        dm.verifyDeployments(path);
        vm.expectRevert(bytes("deployments entry has a factory with other settings: demo"));
        dm.deploy(_config(_entry("demo", address(demoIx), "dm"), address(0)), path, true, deployer);
        _cleanup();
    }

    function test_deploy_refusesWrongChain() public {
        _use("test_deploy_refusesWrongChain");
        string memory c = _config(_entry("demo", address(demoIx), "demo"), address(0));
        vm.chainId(10_143);
        vm.expectRevert(bytes("config chainId != this chain"));
        dm.deploy(c, path, true, deployer);
    }

    function test_deploy_floatNeedsTheMinter() public {
        _use("test_deploy_floatNeedsTheMinter");
        vm.expectRevert(bytes("the bot float needs the minter as sender"));
        dm.deploy(_config(_entry("demo", address(demoIx), "demo"), address(0)), path, true, makeAddr("someoneElse"));
    }

    /// The Kuru router can be the test suite's MockKuruRouter, deployed by the script (market-local.json).
    function test_deploy_kuruMock() public {
        _use("test_deploy_kuruMock");
        string memory c = _config(_entry("demo", address(demoIx), "demo"), address(0));
        c = vm.replace(
            c, string.concat('"router":', _q(address(kuru))), '"router":"0x0000000000000000000000000000000000000000","deployMock":true'
        );
        DeployMarket.Plan memory p = dm.deploy(c, path, true, deployer);
        assertTrue(p.kuruRouter != address(0) && p.kuruRouter != address(kuru));
        assertGt(p.kuruRouter.code.length, 0);
        assertEq(AgateFactory(p.factories[0]).kuruRouter(), p.kuruRouter);
        // reused on the next run
        assertEq(dm.deploy(c, path, true, deployer).kuruRouter, p.kuruRouter);
        _cleanup();
    }

    /// Audit M3 (security), BUILD-SPEC 10.1: with a key (run() reads AGATE_DEPLOYER_KEY), every transaction is signed
    /// with it: here the key of `deployer`, the minter, so the float (minter only) is minted.
    function test_deploy_signsWithTheKey() public {
        _use("test_deploy_signsWithTheKey");
        string memory c = _config(_entry("demo", address(demoIx), "demo"), address(0));
        DeployMarket.Plan memory p = dm.deployWithKey(c, path, true, uint256(keccak256("deployer")));
        assertEq(vm.addr(uint256(keccak256("deployer"))), deployer, "makeAddr's key");
        assertTrue(p.dollarFresh);
        assertEq(AgateDollar(p.dollar).balanceOf(bot), 10_000_000e6, "signed as the minter");
        assertEq(AgateFactory(p.factories[0]).marketAdmin(), deployer);
        _cleanup();
    }

    /// Audit L4 (conformance): a run that deployed the dollar and died before the float leaves a dollar with no
    /// supply; the rerun reuses it and mints the float. A float the bot has since spent is never topped up by a
    /// rerun (only reported).
    function test_deploy_floatAfterAPartialRun() public {
        _use("test_deploy_floatAfterAPartialRun");
        AgateDollar unminted = new AgateDollar(deployer, 10_000e6, 86_400);
        vm.writeFile(path, string.concat('{"dollar":', _q(address(unminted)), "}"));
        DeployMarket.Plan memory p = dm.deploy(_config(_entry("demo", address(demoIx), "demo"), address(0)), path, true, deployer);
        assertEq(p.dollar, address(unminted));
        assertFalse(p.dollarFresh);
        assertEq(unminted.balanceOf(bot), 10_000_000e6, "the missing float is minted");
        vm.prank(bot);
        unminted.transfer(makeAddr("somewhere"), 4_000_000e6);
        dm.deploy(_config(_entry("demo", address(demoIx), "demo"), address(0)), path, true, deployer);
        assertEq(unminted.balanceOf(bot), 6_000_000e6, "a spent float is not topped up by a rerun");
        assertEq(unminted.totalSupply(), 10_000_000e6);
        _cleanup();
    }

    /// The test suite's MockKuruRouter is deployed only on a local anvil (chain 31337), never on a testnet config.
    function test_deploy_kuruMockIsLocalOnly() public {
        _use("test_deploy_kuruMockIsLocalOnly");
        string memory c = _config(_entry("demo", address(demoIx), "demo"), address(0));
        c = vm.replace(
            c, string.concat('"router":', _q(address(kuru))), '"router":"0x0000000000000000000000000000000000000000","deployMock":true'
        );
        c = vm.replace(c, '"chainId":31337', '"chainId":10143');
        vm.chainId(10_143);
        vm.expectRevert(bytes("kuru.deployMock is for a local anvil only (chain 31337)"));
        dm.deploy(c, path, true, deployer);
        assertFalse(vm.exists(path));
        assertFalse(vm.exists(pending));
    }

    /// v3.3 (review): forge runs the script before it broadcasts, so a broadcast that fails or is cut off must
    /// not leave addresses without code in the deployments file. verify() refuses the pending file (and changes
    /// nothing) until every address has code; a rerun reuses what landed and redeploys the rest.
    function test_verify_refusesAddressesWithoutCode() public {
        _use("test_verify_refusesAddressesWithoutCode");
        string memory c = _config(_entry("demo", address(demoIx), "demo"), address(0));
        DeployMarket.Plan memory a = dm.deploy(c, path, true, deployer);
        dm.verifyDeployments(path);
        string memory before = vm.readFile(path);
        // a second run: the pilot entry is added, then its broadcast "never lands"
        string memory c2 = _config(string.concat(_entry("demo", address(demoIx), "demo"), ",", _pilot(true)), address(0));
        DeployMarket.Plan memory b = dm.deploy(c2, path, true, deployer);
        assertEq(b.factories[0], a.factories[0]);
        vm.etch(b.factories[1], "");
        vm.expectRevert(bytes("no code at the address of .factories.pilot.factory"));
        dm.verifyDeployments(path);
        assertEq(vm.readFile(path), before, "the deployments file is unchanged");
        assertTrue(vm.exists(pending));
        // the rerun reads the pending file, reuses the dollar and the demo factory, and redeploys the pilot
        DeployMarket.Plan memory r = dm.deploy(c2, path, true, deployer);
        assertEq(r.dollar, a.dollar);
        assertEq(r.factories[0], a.factories[0]);
        assertTrue(r.factories[1] != b.factories[1] && r.factories[1].code.length != 0);
        dm.verifyDeployments(path);
        assertEq(vm.parseJsonAddress(vm.readFile(path), ".factories.pilot.factory"), r.factories[1]);
        assertFalse(vm.exists(pending));
        _cleanup();
    }

    function test_verify_needsAPendingFileAndTheFactorysRouter() public {
        _use("test_verify_needsAPendingFileAndTheFactorysRouter");
        vm.expectRevert(bytes("no pending deployments file: run DeployMarket with --broadcast first"));
        dm.verifyDeployments(path);
        dm.deploy(_config(_entry("demo", address(demoIx), "demo"), address(0)), path, true, deployer);
        vm.writeJson(_q(address(kuru)), pending, ".factories.demo.router"); // code, but not the factory's router
        vm.expectRevert(bytes("not the factory's router: .factories.demo"));
        dm.verifyDeployments(path);
        vm.writeJson("10143", pending, ".chainId");
        vm.expectRevert(bytes("the pending deployments file is for another chain"));
        dm.verifyDeployments(path);
        assertFalse(vm.exists(path));
        _cleanup();
    }

    // ------------------------------------------------------------------ the signing key (EnvKey, BUILD-SPEC 10.1)

    /// v3.3 (review): a key variable that is set must be a nonzero 0x-prefixed hex key, else the run stops; an
    /// unset one falls back to --sender / --account. vm.envOr returned 0 for "" and for a key without 0x, which sent
    /// as another account. Each case has its own variable name (tests share one process environment).
    function test_envKey_failsClosed() public {
        assertEq(dm.envKey("AGATE_TEST_KEY_UNSET_4f1c"), 0, "unset: the --sender path");
        uint256 k = uint256(keccak256("agate env key test"));
        string memory hexKey = vm.toString(bytes32(k));
        vm.setEnv("AGATE_TEST_KEY_GOOD", hexKey);
        assertEq(dm.envKey("AGATE_TEST_KEY_GOOD"), k);
        assertEq(ls.envKey("AGATE_TEST_KEY_GOOD"), k);
        string[6] memory bad;
        bad[0] = ""; // a failed Keychain read
        bad[1] = vm.replace(hexKey, "0x", ""); // the key without 0x
        bad[2] = "0x";
        bad[3] = "0x0000000000000000000000000000000000000000000000000000000000000000";
        bad[4] = string.concat(hexKey, "00"); // too long
        bad[5] = "0xzz";
        for (uint256 i; i < bad.length; ++i) {
            string memory name = string.concat("AGATE_TEST_KEY_BAD_", vm.toString(i));
            vm.setEnv(name, bad[i]);
            vm.expectRevert(bytes(string.concat(name, " is set but is not a nonzero 0x-prefixed hex key")));
            dm.envKey(name);
        }
    }

    /// v3.4 (review): an entry's AGATE_INDEX_<name> override fails closed like the keys. vm.envOr fell back to
    /// the config's index for a value it could not parse (a command substitution that yielded "" or "null"), so a
    /// stale index with code was deployed on. Now a set variable must be a nonzero address with code, else the run
    /// stops naming the variable; a good one replaces the config's index, an unset one keeps it. Each case has its
    /// own entry name (tests share one process environment).
    function test_deploy_indexOverrideFailsClosed() public {
        _use("test_deploy_indexOverrideFailsClosed");
        assertEq(dm.envIndex("AGATE_INDEX_unset4f1c", address(demoIx)), address(demoIx), "unset: the config's index");
        vm.setEnv("AGATE_INDEX_ixgood", vm.toString(address(realIx)));
        DeployMarket.Plan memory p =
            dm.deploy(_config(_entry("ixgood", address(demoIx), "demo"), address(0)), path, false, deployer);
        assertEq(AgateFactory(p.factories[0]).index(), address(realIx), "a good override wins");
        string[5] memory bad;
        bad[0] = ""; // a command substitution that yielded nothing
        bad[1] = "null"; // jq's answer for a missing key
        bad[2] = "0x12"; // not an address
        bad[3] = vm.toString(address(0));
        bad[4] = vm.toString(makeAddr("no code here"));
        for (uint256 i; i < bad.length; ++i) {
            string memory name = string.concat("ixbad", vm.toString(i));
            vm.setEnv(string.concat("AGATE_INDEX_", name), bad[i]);
            vm.expectRevert(bytes(string.concat("AGATE_INDEX_", name, " is set but is not an address with code")));
            dm.deploy(_config(_entry(name, address(demoIx), "demo"), address(0)), path, false, deployer);
        }
        assertFalse(vm.exists(path));
        assertFalse(vm.exists(pending));
    }

    /// Both scripts' run() read their key through envKey: a set but unusable key stops them before any transaction.
    function test_run_failsClosedOnABadKey() public {
        vm.setEnv("AGATE_DEPLOYER_KEY", "");
        vm.expectRevert(bytes("AGATE_DEPLOYER_KEY is set but is not a nonzero 0x-prefixed hex key"));
        dm.run();
        vm.setEnv("AGATE_FACTORY", vm.toString(address(this)));
        vm.setEnv("AGATE_PAYER_KEY", "0123");
        vm.expectRevert(bytes("AGATE_PAYER_KEY is set but is not a nonzero 0x-prefixed hex key"));
        ls.run();
    }

    // ------------------------------------------------------------------ ListSeries

    /// Audit M3 (security): with a key (run() reads AGATE_PAYER_KEY) the lister signs with it, also across the
    /// snapshot it takes before each createMarket.
    function test_listSeries_signsWithTheKey() public {
        _use("test_listSeries_signsWithTheKey");
        DeployMarket.Plan memory p = dm.deploy(_config(_entry("demo", address(demoIx), "demo"), address(0)), path, true, deployer);
        IAgateFactory f = IAgateFactory(p.factories[0]);
        demoIx.put(H100, OCT1, 3_600_000, T0 + 960, IAgateIndex.Status.FULL, 5, false, false);
        vm.warp(T0 + 960);
        uint256 key = uint256(keccak256("agate lister test key"));
        vm.recordLogs();
        ListSeries.Done memory d = ls.listWithKey(f, key);
        assertEq(d.listed, 2);
        assertEq(d.markets, 2);
        // recordLogs keeps the logs of the trial createMarket each series gets on a snapshot outside the broadcast
        // (sent by the script contract, then rolled back); every recorded one is sent by the key
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 byKey;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(f)) continue;
            if (logs[i].topics[0] != IAgateFactory.MarketRecorded.selector) continue;
            address by = address(uint160(uint256(logs[i].topics[3])));
            if (by == vm.addr(key)) ++byKey;
            else assertEq(by, address(ls), "only the rolled-back trial is sent by the script contract");
        }
        assertEq(byKey, 2, "createMarket sent by the key");
        _cleanup();
    }

    function test_listSeries() public {
        _use("test_listSeries");
        DeployMarket.Plan memory p = dm.deploy(_config(_entry("demo", address(demoIx), "demo"), address(0)), path, true, deployer);
        IAgateFactory f = IAgateFactory(p.factories[0]);
        // H100 and H200 have a final Oct 1 record on the demo clock; B200 none yet
        demoIx.put(H100, OCT1, 3_600_000, T0 + 960, IAgateIndex.Status.FULL, 5, false, false);
        demoIx.put(H200, OCT1, 4_000_000, T0 + 960, IAgateIndex.Status.FULL, 5, false, false);
        vm.warp(T0 + 960);
        ListSeries.Done memory d = ls.listAs(f, deployer);
        assertEq(d.listed, 4, "Oct and Nov for H100 and H200");
        assertEq(d.markets, 4);
        assertEq(d.skipped, 2, "B200 not ready, both months");
        uint32 oct = 2026 * 12 + 9;
        address s = f.seriesOf(H100, oct + 1);
        (address m, Venue v) = f.marketOf(s);
        assertTrue(m != address(0));
        assertEq(uint8(v), uint8(Venue.KURU_V1));
        // idempotent
        d = ls.listAs(f, deployer);
        assertEq(d.listed + d.markets, 0);
        // Kuru closes deployProxy: B200 lists, its market is refused and skipped, the run does not fail
        demoIx.put(B200, OCT1, 5_000_000, T0 + 960, IAgateIndex.Status.FULL, 5, false, false);
        kuru.setPermissionless(false);
        d = ls.listAs(f, deployer);
        assertEq(d.listed, 2);
        assertEq(d.markets, 0);
        assertEq(d.skipped, 2);
        (, v) = f.marketOf(f.seriesOf(B200, oct));
        assertEq(uint8(v), uint8(Venue.NONE));
        _cleanup();
    }
}
