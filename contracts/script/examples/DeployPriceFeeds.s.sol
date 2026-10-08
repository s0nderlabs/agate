// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {EnvKey} from "../EnvKey.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";
import {AgatePriceFeed} from "../../src/examples/AgatePriceFeed.sol";

/// Deploys the example feed (src/examples/AgatePriceFeed.sol) for every GPU of the real-calendar index on Monad
/// testnet and writes deployments/10143-feeds.json. Key: AGATE_DEPLOYER_KEY (the Keychain deployer, read by the
/// caller into the environment, never printed). Example only: the market does not use these feeds.
contract DeployPriceFeeds is EnvKey {
    string internal constant CONFIG = "script/config/testnet-production.json";
    string internal constant DEPLOYMENTS = "deployments/10143.json";
    string internal constant OUT = "deployments/10143-feeds.json";

    function run() external {
        require(block.chainid == 10_143, "Monad testnet only");
        string memory cfg = vm.readFile(CONFIG);
        IAgateIndex index = IAgateIndex(vm.parseJsonAddress(vm.readFile(DEPLOYMENTS), ".factories.real.index"));
        uint256 n = abi.decode(vm.parseJson(cfg, ".gpus"), (bytes[])).length;
        string memory json = "feeds";
        string memory last;
        uint256 key = envKey("AGATE_DEPLOYER_KEY");
        require(key != 0, "set AGATE_DEPLOYER_KEY");
        vm.startBroadcast(key);
        for (uint256 i = 0; i < n; ++i) {
            string memory at = string.concat(".gpus[", vm.toString(i), "]");
            string memory gpu = vm.parseJsonString(cfg, string.concat(at, ".gpu"));
            bytes32 gpuId = vm.parseJsonBytes32(cfg, string.concat(at, ".gpuId"));
            AgatePriceFeed feed = new AgatePriceFeed(index, gpuId, string.concat("agate ", gpu, " / USD per GPU-hour"));
            console2.log(gpu, address(feed));
            last = vm.serializeAddress(json, gpu, address(feed));
        }
        vm.stopBroadcast();
        vm.serializeAddress(json, "index", address(index));
        last = vm.serializeUint(json, "chainId", block.chainid);
        vm.writeJson(last, OUT);
    }
}
