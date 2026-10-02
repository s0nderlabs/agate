// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {IAgateFactory} from "../src/market/interfaces/IAgateFactory.sol";
import {IAgateSeries} from "../src/market/interfaces/IAgateSeries.sol";
import {IAgateToken} from "../src/market/interfaces/IAgateToken.sol";
import {Listing, Venue} from "../src/market/MarketTypes.sol";
import {EnvKey} from "./EnvKey.sol";

/// The lister's pass for one factory (BUILD-SPEC 10.3, 6.6): for every GPU and for the current and the next month,
/// list if not listed and previewListing does not revert, then createMarket if no market is recorded and the
/// factory has a Kuru router. Idempotent; anything not ready yet is printed and skipped. createMarket is first
/// tried outside the broadcast on a state snapshot, so a Kuru refusal skips that series instead of failing the run.
///
///   AGATE_FACTORY=0x... forge script script/ListSeries.s.sol --rpc-url anvil --broadcast --slow --non-interactive \
///     --unlocked --sender 0x...
///
/// On testnet (phase 4) the lister is the payer key (BUILD-SPEC 6.6), read into the forge process's environment only
/// (10.1), never onto a command line or into a file:
///
///   AGATE_PAYER_KEY="$(security find-generic-password -s agate.market.payer -a private-key -w)" \
///   AGATE_FACTORY=0x... forge script script/ListSeries.s.sol --rpc-url <monad testnet> --broadcast --slow \
///     --non-interactive
///
/// The script signs with that key; a set variable that is not a nonzero 0x-prefixed hex key stops the run (EnvKey).
/// Only without the variable does it send as --sender / --account.
contract ListSeries is EnvKey {
    struct Done {
        uint256 listed;
        uint256 markets;
        uint256 skipped;
    }

    uint256 internal key; // nonzero: every transaction is signed with it

    function run() external returns (Done memory done) {
        done = listWithKey(IAgateFactory(vm.envAddress("AGATE_FACTORY")), envKey("AGATE_PAYER_KEY"));
    }

    /// key_ zero: as listAs with the script's sender.
    function listWithKey(IAgateFactory f, uint256 key_) public returns (Done memory done) {
        key = key_;
        done = listAs(f, address(0));
        key = 0;
    }

    /// as_ zero: the script's sender (--sender / --account); tests pass an address.
    function listAs(IAgateFactory f, address as_) public returns (Done memory done) {
        _start(as_);
        (, address sender,) = vm.readCallers();
        done = _listAll(f, sender);
        vm.stopBroadcast();
    }

    function _start(address as_) internal {
        if (key != 0) vm.startBroadcast(key);
        else if (as_ == address(0)) vm.startBroadcast();
        else vm.startBroadcast(as_);
    }

    function _listAll(IAgateFactory f, address sender) internal returns (Done memory done) {
        uint32 cur = f.currentMonth();
        bytes32[] memory ids = f.gpuIds();
        for (uint256 g; g < ids.length; ++g) {
            for (uint32 m = cur; m <= cur + 1; ++m) {
                address s = f.seriesOf(ids[g], m);
                string memory what = string.concat(f.labelOf(ids[g]), " month ", vm.toString(m));
                if (s == address(0)) {
                    try f.previewListing(ids[g], m) returns (Listing memory) {
                        s = f.list(ids[g], m);
                        ++done.listed;
                        console2.log(string.concat("listed ", what, " ", IAgateToken(IAgateSeries(s).token()).symbol()), s);
                    } catch (bytes memory err) {
                        ++done.skipped;
                        console2.log(string.concat("not listable yet: ", what, " ", _why(err)));
                        continue;
                    }
                }
                if (f.kuruRouter() == address(0)) continue;
                (address mk, Venue v) = f.marketOf(s);
                if (v != Venue.NONE) {
                    console2.log(string.concat("market recorded: ", what), mk);
                    continue;
                }
                if (!_wouldCreate(f, s, sender)) {
                    ++done.skipped;
                    console2.log(string.concat("createMarket refused: ", what));
                    continue;
                }
                mk = f.createMarket(s);
                ++done.markets;
                console2.log(string.concat("market created: ", what), mk);
            }
        }
    }

    function _wouldCreate(IAgateFactory f, address s, address sender) internal returns (bool ok) {
        vm.stopBroadcast();
        uint256 snap = vm.snapshotState();
        (ok,) = address(f).call(abi.encodeCall(IAgateFactory.createMarket, (s))); // anyone may call it
        vm.revertToState(snap);
        _start(sender);
    }

    function _why(bytes memory err) internal pure returns (string memory) {
        if (err.length < 4) return "(no reason)";
        bytes4 sel = bytes4(err);
        if (sel == IAgateFactory.NotReady.selector) return "NotReady";
        if (sel == IAgateFactory.IndexStartsAfterMonth.selector) return "IndexStartsAfterMonth";
        if (sel == IAgateFactory.MonthNotOpen.selector) return "MonthNotOpen";
        if (sel == IAgateFactory.UnknownGpu.selector) return "UnknownGpu";
        if (sel == IAgateFactory.AlreadyListed.selector) return "AlreadyListed";
        if (sel == IAgateFactory.BadBand.selector) return "BadBand";
        return vm.toString(abi.encodePacked(sel));
    }
}
