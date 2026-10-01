// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReceiver} from "../../src/interfaces/IReceiver.sol";

/// Stands in for the CRE simulation forwarder: forwards (metadata, report) to onReport inside try/catch and never
/// reverts, so a rejected report looks like a successful transaction (BUILD-SPEC 4.14, 11).
contract MockForwarder {
    event Forwarded(address indexed receiver, bool ok, bytes err);

    function forward(address receiver, bytes calldata metadata, bytes calldata report) external returns (bool ok) {
        try IReceiver(receiver).onReport(metadata, report) {
            ok = true;
            emit Forwarded(receiver, true, "");
        } catch (bytes memory err) {
            emit Forwarded(receiver, false, err);
        }
    }
}
