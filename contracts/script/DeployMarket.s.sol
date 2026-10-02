// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IAgateIndex} from "../src/interfaces/IAgateIndex.sol";
import {AgateDollar} from "../src/market/AgateDollar.sol";
import {AgateFactory} from "../src/market/AgateFactory.sol";
import {IAgateDollar} from "../src/market/interfaces/IAgateDollar.sol";
import {MockKuruRouter} from "../test/market/mocks/MockKuruRouter.sol";
import {EnvKey} from "./EnvKey.sol";

/// Deploys the market from script/config/market-<AGATE_MARKET_CONFIG>.json (BUILD-SPEC 10.2, 10.3): the dollar
/// (or an existing one), the bot float (our dollar only, once: see _botFloat), one factory per enabled
/// `factories` entry (each deploys its router), then merges every address into deployments/<file>.pending without
/// deleting other keys. Idempotent: an address already in the deployments file (the pending one if a run left it)
/// with code is reused (a factory only if its settings equal the config's, else the run stops). Refuses a config in
/// which two factories share an (index, dollar) or a symbol prefix. A dry run (no --broadcast) writes nothing.
///
/// forge runs this code before it sends any transaction, so the file it writes is only a plan (v3.3). After the
/// broadcast, `verify()` checks that every address in the pending file has code on the chain and only then moves it
/// to deployments/<file>, which the bots, the indexer and the app read. A broadcast that failed or was cut off leaves
/// the pending file and the deployments file as they were: rerun DeployMarket (it reuses every address that landed),
/// then verify again.
///
///   local anvil (after DeployIndex with AGATE_CONFIG=local-demo):
///   AGATE_MARKET_CONFIG=local forge script script/DeployMarket.s.sol --rpc-url anvil --broadcast --slow \
///     --non-interactive --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
///   AGATE_MARKET_CONFIG=local forge script script/DeployMarket.s.sol --sig 'verify()' --rpc-url anvil
///
/// --non-interactive: the factory's runtime (about 33 KB, it carries the series' creation code) is above
/// Ethereum's 24 KB, which Monad allows (128 KB); forge warns and would otherwise stop to ask.
/// --slow: one transaction at a time; with batched sends anvil (forge 1.3.5) left the later creations pending
/// for ever (seen Oct 2 2026, n = 1).
///
/// An entry's index can be overridden with AGATE_INDEX_<name> (e.g. AGATE_INDEX_demo); a set variable that is not a
/// nonzero address with code stops the run (envIndex), it never falls back to the config's index. Testnet runs only in
/// phase 4 with the operator's go, the key read into the forge process's environment only (BUILD-SPEC 10.1), never
/// onto a command line or into a file:
///
///   AGATE_DEPLOYER_KEY="$(security find-generic-password -s agate.deployer -a private-key -w)" \
///   AGATE_MARKET_CONFIG=testnet forge script script/DeployMarket.s.sol --rpc-url <monad testnet> --broadcast \
///     --slow --non-interactive
///   AGATE_MARKET_CONFIG=testnet forge script script/DeployMarket.s.sol --sig 'verify()' --rpc-url <monad testnet>
///
/// The script signs with that key; a set variable that is not a nonzero 0x-prefixed hex key stops the run (EnvKey).
/// Only without the variable does it send as --sender / --account.
contract DeployMarket is EnvKey {
    struct Entry {
        string name;
        address index;
        address dollar; // zero: the top-level dollar
        address kuruRouter;
        bool ownKuru; // the entry names its own kuruRouter (the V2 pilot: zero)
        string tag;
        bool enabled;
    }

    struct Plan {
        address dollar;
        bool dollarFresh;
        address kuruRouter;
        address[] factories;
        address[] routers;
    }

    function run() external returns (Plan memory plan) {
        string memory json = _config();
        bool write = !vm.isContext(VmSafe.ForgeContext.ScriptDryRun);
        plan = deployWithKey(json, _outPath(json), write, envKey("AGATE_DEPLOYER_KEY"));
    }

    /// The step after the broadcast: forge script script/DeployMarket.s.sol --sig 'verify()' (no key, no
    /// transaction; the same AGATE_MARKET_CONFIG).
    function verify() external {
        verifyDeployments(_outPath(_config()));
    }

    /// as_ zero: the script's sender (--sender / --account); tests pass an address.
    function deploy(string memory json, string memory outPath, bool write, address as_)
        public
        returns (Plan memory plan)
    {
        plan = _deploy(json, outPath, write, as_, 0);
    }

    /// key nonzero: every transaction is signed with it (BUILD-SPEC 10.1); zero: as deploy with the script's sender.
    function deployWithKey(string memory json, string memory outPath, bool write, uint256 key)
        public
        returns (Plan memory plan)
    {
        plan = _deploy(json, outPath, write, address(0), key);
    }

    function _deploy(string memory json, string memory outPath, bool write, address as_, uint256 key)
        internal
        returns (Plan memory plan)
    {
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "config chainId != this chain");
        string memory pending = _pending(outPath);
        string memory dep = vm.exists(pending) ? vm.readFile(pending) : vm.exists(outPath) ? vm.readFile(outPath) : "{}";
        // one rule picks the top-level dollar for both the clash check and the deploy (zero: this run deploys it)
        plan.dollar = _plannedDollar(json, dep);
        Entry[] memory es = _entries(json, plan.dollar);
        _refuseClashes(es, dep);

        if (key != 0) vm.startBroadcast(key);
        else if (as_ == address(0)) vm.startBroadcast();
        else vm.startBroadcast(as_);
        (, address sender,) = vm.readCallers();

        (plan.dollar, plan.dollarFresh) = _dollar(json, plan.dollar);
        _botFloat(json, plan, sender);
        plan.kuruRouter = _kuru(json, dep);

        plan.factories = new address[](es.length);
        plan.routers = new address[](es.length);
        uint256[] memory startBlocks = new uint256[](es.length);
        for (uint256 i; i < es.length; ++i) {
            if (!es[i].enabled) continue;
            Entry memory e = es[i];
            if (e.dollar == address(0)) e.dollar = plan.dollar;
            if (!e.ownKuru) e.kuruRouter = plan.kuruRouter;
            (plan.factories[i], startBlocks[i]) = _factory(json, dep, e);
            plan.routers[i] = AgateFactory(plan.factories[i]).router();
            es[i] = e;
        }
        vm.stopBroadcast();

        if (write) _write(json, pending, dep, plan, es, startBlocks);
        _print(plan, es);
    }

    /// v3.3: every address of the pending file must have code here (and each router must be its factory's); only
    /// then does the pending file replace the deployments file. Anything missing stops the run and changes nothing.
    function verifyDeployments(string memory outPath) public {
        string memory pending = _pending(outPath);
        require(vm.exists(pending), "no pending deployments file: run DeployMarket with --broadcast first");
        string memory j = vm.readFile(pending);
        require(vm.parseJsonUint(j, ".chainId") == block.chainid, "the pending deployments file is for another chain");
        _hasCode(j, ".dollar");
        if (_addr(j, ".kuru.router") != address(0)) _hasCode(j, ".kuru.router");
        string[] memory names = vm.keyExistsJson(j, ".factories") ? vm.parseJsonKeys(j, ".factories") : new string[](0);
        for (uint256 i; i < names.length; ++i) {
            string memory k = string.concat(".factories.", names[i]);
            address f = _hasCode(j, string.concat(k, ".factory"));
            address r = _hasCode(j, string.concat(k, ".router"));
            _hasCode(j, string.concat(k, ".index"));
            _hasCode(j, string.concat(k, ".dollar"));
            bool mine;
            try AgateFactory(f).router() returns (address fr) {
                mine = fr == r;
            } catch {}
            require(mine, string.concat("not the factory's router: ", k));
        }
        vm.writeFile(outPath, j);
        vm.removeFile(pending);
        console2.log("deployments verified and written", outPath);
    }

    // ------------------------------------------------------------------ config

    /// An entry's index override, failing closed as EnvKey does (v3.4): a variable that is set must hold a nonzero
    /// address with code, else the run stops naming the variable; only an unset one keeps the config's index.
    /// vm.envOr returned the config's index for an empty or unparsable value (a command substitution that yielded ""
    /// or "null"), and a stale index with code passed every later check.
    function envIndex(string memory name, address configIndex) public view returns (address a) {
        if (!vm.envExists(name)) return configIndex;
        string memory bad = string.concat(name, " is set but is not an address with code");
        try vm.envAddress(name) returns (address v) {
            a = v;
        } catch {
            revert(bad);
        }
        if (a == address(0) || a.code.length == 0) revert(bad);
    }

    function _config() internal view returns (string memory) {
        string memory name = vm.envOr("AGATE_MARKET_CONFIG", string("local"));
        return vm.readFile(string.concat(vm.projectRoot(), "/script/config/market-", name, ".json"));
    }

    function _outPath(string memory json) internal view returns (string memory) {
        string memory file = vm.keyExistsJson(json, ".deploymentsFile")
            ? vm.parseJsonString(json, ".deploymentsFile")
            : string.concat(vm.toString(block.chainid), ".json");
        return string.concat(vm.projectRoot(), "/deployments/", file);
    }

    function _pending(string memory outPath) internal pure returns (string memory) {
        return string.concat(outPath, ".pending");
    }

    /// The top-level dollar this run uses: the config's, else the deployments file's if it has code, else zero (this
    /// run deploys it). _entries (for the clash check) and _dollar (for the deploy) both take it from here.
    function _plannedDollar(string memory json, string memory dep) internal view returns (address d) {
        d = vm.parseJsonAddress(json, ".dollar.address");
        if (d == address(0)) {
            address prior = _addr(dep, ".dollar");
            if (prior.code.length != 0) d = prior;
        }
    }

    /// topDollar: _plannedDollar's answer, the dollar of every entry that names none.
    function _entries(string memory json, address topDollar) internal view returns (Entry[] memory es) {
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".factories[", vm.toString(n), "]"))) ++n;
        es = new Entry[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".factories[", vm.toString(i), "]");
            Entry memory e;
            e.name = vm.parseJsonString(json, string.concat(k, ".name"));
            require(_nameOk(e.name), "factory name: 1 to 16 characters a-z 0-9");
            e.index = envIndex(string.concat("AGATE_INDEX_", e.name), vm.parseJsonAddress(json, string.concat(k, ".index")));
            e.tag = vm.parseJsonString(json, string.concat(k, ".tag"));
            e.enabled = vm.keyExistsJson(json, string.concat(k, ".enabled"))
                ? vm.parseJsonBool(json, string.concat(k, ".enabled"))
                : true;
            e.dollar = vm.keyExistsJson(json, string.concat(k, ".dollar"))
                ? vm.parseJsonAddress(json, string.concat(k, ".dollar"))
                : topDollar;
            e.ownKuru = vm.keyExistsJson(json, string.concat(k, ".kuruRouter"));
            if (e.ownKuru) e.kuruRouter = vm.parseJsonAddress(json, string.concat(k, ".kuruRouter"));
            es[i] = e;
        }
    }

    /// BUILD-SPEC 10.3 (v3, RC5): no two factories on one chain with the same (index, dollar) or symbol prefix,
    /// counting the enabled entries and the factories already in the deployments file under other names.
    function _refuseClashes(Entry[] memory es, string memory dep) internal view {
        uint256 n;
        for (uint256 i; i < es.length; ++i) {
            if (es[i].enabled) ++n;
        }
        string[] memory known = vm.keyExistsJson(dep, ".factories") ? vm.parseJsonKeys(dep, ".factories") : new string[](0);
        Entry[] memory all = new Entry[](n + known.length);
        uint256 m;
        for (uint256 i; i < es.length; ++i) {
            if (!es[i].enabled) continue;
            require(es[i].index != address(0) && es[i].index.code.length != 0, string.concat("index has no code: ", es[i].name));
            all[m++] = es[i];
        }
        for (uint256 j; j < known.length; ++j) {
            bool inConfig;
            for (uint256 i; i < es.length; ++i) {
                if (es[i].enabled && _same(es[i].name, known[j])) inConfig = true;
            }
            if (inConfig) continue;
            string memory k = string.concat(".factories.", known[j]);
            Entry memory e;
            e.name = known[j];
            e.index = _addr(dep, string.concat(k, ".index"));
            e.dollar = _addr(dep, string.concat(k, ".dollar"));
            e.tag = vm.keyExistsJson(dep, string.concat(k, ".tag")) ? vm.parseJsonString(dep, string.concat(k, ".tag")) : "";
            all[m++] = e;
        }
        for (uint256 a; a < m; ++a) {
            for (uint256 b = a + 1; b < m; ++b) {
                require(!_same(all[a].name, all[b].name), string.concat("duplicate factory name: ", all[a].name));
                bool sameDollar = all[a].dollar == all[b].dollar;
                require(
                    !(all[a].index == all[b].index && sameDollar),
                    string.concat("two factories share (index, dollar): ", all[a].name, ", ", all[b].name)
                );
                require(
                    !_same(_prefix(all[a].tag), _prefix(all[b].tag)),
                    string.concat("two factories share a symbol prefix: ", all[a].name, ", ", all[b].name)
                );
            }
        }
    }

    // ------------------------------------------------------------------ deployments

    /// planned: _plannedDollar's answer. The config's dollar is checked, the deployments file's must have the
    /// config's minter; with neither, a new AgateDollar.
    function _dollar(string memory json, address planned) internal returns (address d, bool fresh) {
        address minter = vm.parseJsonAddress(json, ".dollar.minter");
        if (planned != address(0)) {
            if (vm.parseJsonAddress(json, ".dollar.address") != address(0)) {
                require(planned.code.length != 0, "dollar has no code");
                require(AgateDollar(planned).decimals() == 6, "dollar must have 6 decimals");
            } else {
                require(_minterOf(planned) == minter, "deployments dollar has another minter");
                console2.log("dollar reused", planned);
            }
            return (planned, false);
        }
        d = address(
            new AgateDollar(
                minter,
                vm.parseJsonUint(json, ".dollar.dripAmount"),
                uint64(vm.parseJsonUint(json, ".dollar.dripPeriod"))
            )
        );
        fresh = true;
    }

    /// The market maker's float, only in our own dollar (the config names none). Minted with a fresh dollar, or
    /// with a reused one nobody has minted yet (an earlier run deployed the dollar and died before the float). A
    /// reused dollar whose float holder has less than the amount is only reported: topping it up is a deliberate
    /// minter's mint, never a side effect of a rerun.
    function _botFloat(string memory json, Plan memory plan, address sender) internal {
        if (!vm.keyExistsJson(json, ".botFloat") || vm.parseJsonAddress(json, ".dollar.address") != address(0)) return;
        uint256 amount = vm.parseJsonUint(json, ".botFloat.amount");
        if (amount == 0) return;
        IAgateDollar d = IAgateDollar(plan.dollar);
        address to = vm.parseJsonAddress(json, ".botFloat.to");
        if (plan.dollarFresh || d.totalSupply() == 0) {
            require(sender == d.minter(), "the bot float needs the minter as sender");
            d.mint(to, amount);
            if (!plan.dollarFresh) console2.log("bot float minted: the dollar was reused with no supply", to, amount);
        } else if (d.balanceOf(to) < amount) {
            console2.log("WARNING bot float below botFloat.amount (not topped up by a rerun)", to, d.balanceOf(to));
        }
    }

    /// The Kuru V1 router: the config's address, or (local only, `kuru.deployMock`) the test suite's
    /// MockKuruRouter, whose markets are Solidity order books with Kuru's arithmetic.
    function _kuru(string memory json, string memory dep) internal returns (address kr) {
        kr = vm.parseJsonAddress(json, ".kuru.router");
        if (kr != address(0)) return kr;
        if (!vm.keyExistsJson(json, ".kuru.deployMock") || !vm.parseJsonBool(json, ".kuru.deployMock")) return address(0);
        require(block.chainid == 31_337, "kuru.deployMock is for a local anvil only (chain 31337)");
        address prior = _addr(dep, ".kuru.router");
        if (prior != address(0) && prior.code.length != 0) return prior;
        kr = address(new MockKuruRouter());
    }

    function _factory(string memory json, string memory dep, Entry memory e)
        internal
        returns (address f, uint256 startBlock)
    {
        (bytes32[] memory ids, string[] memory labels) = _gpus(json);
        address admin = vm.parseJsonAddress(json, ".marketAdmin");
        uint256 tf = vm.parseJsonUint(json, ".kuru.takerFeeBps");
        uint256 mf = vm.parseJsonUint(json, ".kuru.makerFeeBps");
        string memory k = string.concat(".factories.", e.name);
        address prior = _addr(dep, string.concat(k, ".factory"));
        if (prior != address(0) && prior.code.length != 0) {
            AgateFactory p = AgateFactory(prior);
            try p.index() returns (address) {}
            catch {
                revert(string.concat("deployments entry is not a factory: ", e.name));
            }
            bytes32[] memory pids = p.gpuIds();
            bool same = p.index() == e.index && p.dollar() == e.dollar && p.kuruRouter() == e.kuruRouter
                && p.marketAdmin() == admin && _same(p.tag(), e.tag) && p.takerFeeBps() == tf && p.makerFeeBps() == mf
                && pids.length == ids.length;
            for (uint256 i; same && i < ids.length; ++i) {
                same = pids[i] == ids[i] && _same(p.labelOf(ids[i]), labels[i]);
            }
            require(same, string.concat("deployments entry has a factory with other settings: ", e.name));
            startBlock = vm.keyExistsJson(dep, string.concat(k, ".startBlock"))
                ? vm.parseJsonUint(dep, string.concat(k, ".startBlock"))
                : block.number;
            console2.log("factory reused", e.name, prior);
            return (prior, startBlock);
        }
        f = address(new AgateFactory(e.index, e.dollar, e.kuruRouter, ids, labels, admin, e.tag, tf, mf));
        startBlock = block.number; // at or before the deploy block, so the indexer misses nothing
    }

    function _gpus(string memory json) internal view returns (bytes32[] memory ids, string[] memory labels) {
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".gpus[", vm.toString(n), "]"))) ++n;
        ids = new bytes32[](n);
        labels = new string[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".gpus[", vm.toString(i), "]");
            ids[i] = vm.parseJsonBytes32(json, string.concat(k, ".gpuId"));
            labels[i] = vm.parseJsonString(json, string.concat(k, ".label"));
        }
    }

    /// Writes the pending file: what the deployments file held (dep), merged with this run's addresses.
    function _write(
        string memory json,
        string memory path,
        string memory dep,
        Plan memory plan,
        Entry[] memory es,
        uint256[] memory sb
    ) internal {
        if (!vm.exists(path)) vm.writeFile(path, dep);
        vm.writeJson(vm.toString(block.chainid), path, ".chainId");
        vm.writeJson(_q(plan.dollar), path, ".dollar");
        vm.writeJson(_q(plan.kuruRouter), path, ".kuru.router");
        if (vm.keyExistsJson(json, ".kuru.marginAccount")) {
            vm.writeJson(_q(vm.parseJsonAddress(json, ".kuru.marginAccount")), path, ".kuru.marginAccount");
        }
        for (uint256 i; i < es.length; ++i) {
            if (!es[i].enabled) continue;
            string memory k = string.concat(".factories.", es[i].name);
            vm.writeJson(_q(es[i].index), path, string.concat(k, ".index"));
            vm.writeJson(_q(es[i].dollar), path, string.concat(k, ".dollar"));
            vm.writeJson(string.concat('"', es[i].tag, '"'), path, string.concat(k, ".tag"));
            vm.writeJson(_q(plan.factories[i]), path, string.concat(k, ".factory"));
            vm.writeJson(_q(plan.routers[i]), path, string.concat(k, ".router"));
            vm.writeJson(vm.toString(uint256(IAgateIndex(es[i].index).clocks().tPend)), path, string.concat(k, ".tPend"));
            vm.writeJson(vm.toString(sb[i]), path, string.concat(k, ".startBlock"));
        }
        console2.log("pending deployments written (run verify() after the broadcast)", path);
    }

    function _print(Plan memory plan, Entry[] memory es) internal pure {
        console2.log("dollar", plan.dollar, plan.dollarFresh ? "(new)" : "(existing)");
        console2.log("kuru router", plan.kuruRouter);
        for (uint256 i; i < es.length; ++i) {
            if (!es[i].enabled) {
                console2.log("skipped (disabled)", es[i].name);
                continue;
            }
            console2.log(string.concat("factory ", es[i].name, " tag '", es[i].tag, "'"));
            console2.log("  index  ", es[i].index);
            console2.log("  factory", plan.factories[i]);
            console2.log("  router ", plan.routers[i]);
        }
    }

    // ------------------------------------------------------------------ helpers

    function _addr(string memory json, string memory key) internal view returns (address) {
        return vm.keyExistsJson(json, key) ? vm.parseJsonAddress(json, key) : address(0);
    }

    function _hasCode(string memory json, string memory key) internal view returns (address a) {
        a = _addr(json, key);
        require(a.code.length != 0, string.concat("no code at the address of ", key));
    }

    function _minterOf(address d) internal view returns (address m) {
        try IAgateDollar(d).minter() returns (address x) {
            m = x;
        } catch {}
    }

    function _q(address a) internal pure returns (string memory) {
        return string.concat('"', vm.toString(a), '"');
    }

    function _same(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /// A symbol prefix: "" for an empty tag, else the tag's first letter (BUILD-SPEC 4.2).
    function _prefix(string memory tag) internal pure returns (string memory) {
        bytes memory t = bytes(tag);
        return t.length == 0 ? "" : string(abi.encodePacked(t[0]));
    }

    function _nameOk(string memory name) internal pure returns (bool) {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 16) return false;
        for (uint256 i; i < b.length; ++i) {
            bool ok = (b[i] >= 0x61 && b[i] <= 0x7a) || (b[i] >= 0x30 && b[i] <= 0x39);
            if (!ok) return false;
        }
        return true;
    }
}
