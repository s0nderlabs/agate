// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";

/// The signing key of a market script, read from the forge process's environment only (BUILD-SPEC 10.1, v3.3). A
/// variable that is set must hold a nonzero 0x-prefixed hex key, or the run stops before any transaction; only an
/// unset variable falls back to the script's sender (--sender / --account). vm.envOr returned its default for an
/// empty value or a key without 0x, so a failed Keychain read silently sent as another account. The messages
/// never echo the value.
abstract contract EnvKey is Script {
    function envKey(string memory name) public view returns (uint256 key) {
        if (!vm.envExists(name)) return 0;
        string memory bad = string.concat(name, " is set but is not a nonzero 0x-prefixed hex key");
        string memory raw;
        try vm.envString(name) returns (string memory v) {
            raw = v;
        } catch {
            revert(bad);
        }
        bytes memory b = bytes(raw);
        if (b.length < 3 || b.length > 66 || b[0] != "0" || b[1] != "x") revert(bad);
        try vm.parseUint(raw) returns (uint256 k) {
            key = k;
        } catch {
            revert(bad);
        }
        if (key == 0) revert(bad);
    }
}
