// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-165.
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Chainlink CRE receiver: the forwarder calls onReport(metadata, report).
/// metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner) (62 bytes; the
/// production forwarder may append 2 more bytes, so read the owner at [42:62]).
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
