// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {IAgateIndex, ACTION_WINDOW_DAYS, READER_SWAP_TAG} from "../src/interfaces/IAgateIndex.sol";
import {EnvKey} from "./EnvKey.sol";

/// Queues, executes or cancels the owner's timelocked actions and reader swaps listed in a JSON file, or prints
/// their status (BUILD-SPEC 13.3, 4.11, 4.15). Sent only by the operator, with the owner key read into the forge
/// process's environment (never onto a command line or into a file), against the key-free public RPC:
///
///   AGATE_OWNER_KEY="$(security find-generic-password -s agate.wall.owner -a private-key -w)" \
///   AGATE_INDEX=0x... AGATE_OWNER_ACTION="$(cat '<abs path>')" [AGATE_OWNER_ACTION_SHA256=<64 hex>] \
///   forge script script/OwnerAction.s.sol --sig 'queue()' --rpc-url https://testnet-rpc.monad.xyz --broadcast
///
///   --sig 'execute()' / 'cancel()': the same file; 'status()': no key, nothing sent. forge reads only the repo's own
///   folders (foundry.toml), so a file outside the repo is passed as its JSON; AGATE_OWNER_ACTION_SHA256, when set,
///   must equal the sha256 of that JSON (the repair note pins it) or the run stops. Every entry's fields are printed
///   before anything is sent.
///
/// The file: { "actions": [ { "kind": "READER", "gpuId": "0x...", "slot": 3, "url": "https://...",
///   "parserVersion": "lambda/2", "reason": "..." }, { "kind": "WRITER", "slot": 1, "addr": "0x..." }, ... ] }.
/// kind is an ActionKind name (WRITER, ATTESTER, GUARDIAN, FORWARDER, LIVE_FROM, LIVE_UNTIL, OWNER) or READER; each
/// kind takes exactly its fields (WRITER, GUARDIAN: slot, addr; ATTESTER, OWNER: addr; FORWARDER: addr, mode;
/// LIVE_FROM, LIVE_UNTIL: gpuId, slot, day; READER: gpuId, slot, url, parserVersion, reason), every one present; any
/// other field stops the run (the script sets unused fields to zero, so the contract's BadAction rule holds). Keys
/// starting with "_" are comments. AGATE_OWNER_ACTION may also hold the JSON itself (a value starting with "{").
///
/// Before any send every entry is tried in order, as the owner, on a throwaway snapshot of the chain; the first one
/// that would revert (an execute outside [eta, eta + 14 DAY], a queue of a live entry, any contract check) stops the
/// run, naming the entry, and nothing is sent. Then all entries go out in one broadcast run (sequential nonces). A
/// set AGATE_OWNER_KEY must hold a nonzero 0x-prefixed hex key, or the run stops (EnvKey); unset, the script sends
/// as --sender. The broadcaster must be the index's owner. AGATE_INDEX must be set to an address with code.
contract OwnerAction is EnvKey {
    enum Op {
        QUEUE,
        EXECUTE,
        CANCEL
    }

    struct Entry {
        string label; // "entry 2 (READER slot 3)"
        bool isReader;
        IAgateIndex.Action action;
        bytes32 gpuId;
        uint8 slot;
        IAgateIndex.Reader reader;
        string reason;
        bytes32 id; // actionId or readerSwapId
    }

    // field bits
    uint256 internal constant F_SLOT = 1;
    uint256 internal constant F_ADDR = 2;
    uint256 internal constant F_GPU = 4;
    uint256 internal constant F_DAY = 8;
    uint256 internal constant F_MODE = 16;
    uint256 internal constant F_URL = 32;
    uint256 internal constant F_PARSER = 64;
    uint256 internal constant F_REASON = 128;

    // ------------------------------------------------------------------ the operator's commands (--sig)

    function queue() external {
        _fromEnv(Op.QUEUE);
    }

    function execute() external {
        _fromEnv(Op.EXECUTE);
    }

    function cancel() external {
        _fromEnv(Op.CANCEL);
    }

    /// Sends nothing and needs no key.
    function status() external returns (string[] memory lines) {
        address index = envIndex();
        lines = statusOf(index, actionJson());
        console2.log("to queue, execute or cancel these entries:");
        console2.log(command("queue()", index, _fileRef()));
    }

    // The environment variable names. A test harness overrides them: tests share one process environment.
    function _keyVar() internal view virtual returns (string memory) {
        return "AGATE_OWNER_KEY";
    }

    function _indexVar() internal view virtual returns (string memory) {
        return "AGATE_INDEX";
    }

    function _fileVar() internal view virtual returns (string memory) {
        return "AGATE_OWNER_ACTION";
    }

    function _shaVar() internal view virtual returns (string memory) {
        return "AGATE_OWNER_ACTION_SHA256";
    }

    function _fromEnv(Op op) internal {
        // in this order: the key, the index, the file
        uint256 key = envKey(_keyVar());
        address index = envIndex();
        string memory json = actionJson();
        send(op, index, json, key);
        if (op == Op.QUEUE) {
            IAgateIndex ix = IAgateIndex(index);
            uint256 eta = ix.queuedEta(parse(json)[0].id);
            console2.log(
                string.concat(
                    "next, from ",
                    vm.toString(eta),
                    " to ",
                    vm.toString(eta + ACTION_WINDOW_DAYS * ix.clocks().day),
                    " (unix seconds), after installing what the entries need:"
                )
            );
            console2.log(command("execute()", index, _fileRef()));
            console2.log("or, to withdraw them:");
            console2.log(command("cancel()", index, _fileRef()));
        }
    }

    /// How the action file is named on the command line: its JSON read by the shell (forge reads only the repo).
    function _fileRef() internal view returns (string memory) {
        string memory v = vm.envString(_fileVar());
        return bytes(v)[0] == "{" ? "\"$(cat '<the same action file>')\"" : string.concat("\"$(cat '", v, "')\"");
    }

    /// The operator's command for sig ("queue()", "execute()", "cancel()" or "status()"). It names the Keychain read,
    /// never a key, and the key-free public RPC on Monad testnet (another chain: a placeholder).
    function command(string memory sig, address index, string memory fileRef) public view returns (string memory) {
        bool sends = !_eq(sig, "status()");
        return string.concat(
            sends ? "AGATE_OWNER_KEY=\"$(security find-generic-password -s agate.wall.owner -a private-key -w)\" " : "",
            "AGATE_INDEX=",
            vm.toString(index),
            " AGATE_OWNER_ACTION=",
            fileRef,
            " forge script script/OwnerAction.s.sol --sig '",
            sig,
            "' --rpc-url ",
            block.chainid == 10_143 ? "https://testnet-rpc.monad.xyz" : "<rpc url>",
            sends ? " --broadcast" : ""
        );
    }

    /// Fails closed like DeployMarket's envIndex: unset, or set but not an address with code, stops the run.
    function envIndex() public view returns (address a) {
        string memory name = _indexVar();
        if (!vm.envExists(name)) revert(string.concat(name, " is not set (the index address)"));
        string memory bad = string.concat(name, " is set but is not an address with code");
        try vm.envAddress(name) returns (address v) {
            a = v;
        } catch {
            revert(bad);
        }
        if (a == address(0) || a.code.length == 0) revert(bad);
    }

    /// The action file's JSON: the file named by AGATE_OWNER_ACTION, or the value itself when it starts with "{".
    function actionJson() public view returns (string memory) {
        string memory name = _fileVar();
        if (!vm.envExists(name)) revert(string.concat(name, " is not set (the action file)"));
        string memory v;
        try vm.envString(name) returns (string memory s) {
            v = s;
        } catch {
            revert(string.concat(name, " is empty"));
        }
        if (bytes(v).length == 0) revert(string.concat(name, " is empty"));
        string memory json;
        if (bytes(v)[0] == "{") {
            json = v;
        } else {
            try vm.readFile(v) returns (string memory f) {
                json = f;
            } catch {
                revert(
                    string.concat(
                        name, ": forge may not read ", v, " (only the repo's folders); pass its JSON: ", name, "=\"$(cat '", v, "')\""
                    )
                );
            }
        }
        _checkSha(json);
        return json;
    }

    /// AGATE_OWNER_ACTION_SHA256 set (64 lowercase hex, 0x optional): the JSON must hash to it, so the file the note
    /// was written for is the file that is signed.
    function _checkSha(string memory json) internal view {
        string memory name = _shaVar();
        if (!vm.envExists(name)) return;
        string memory want = vm.envString(name);
        if (bytes(want).length == 64) want = string.concat("0x", want);
        if (bytes(want).length != 66) revert(string.concat(name, " is set but is not a sha256 in hex"));
        string memory got = vm.toString(sha256(bytes(json)));
        if (keccak256(bytes(want)) != keccak256(bytes(got))) {
            revert(string.concat(name, ": the action JSON changed since the note (sha256 ", got, ")"));
        }
    }

    // ------------------------------------------------------------------ send and status

    /// key nonzero: signed with it; zero: sent as the script's sender (--sender / --account).
    function send(Op op, address index, string memory json, uint256 key) public {
        IAgateIndex ix = IAgateIndex(index);
        Entry[] memory es = parse(json);
        _checkIds(ix, es);
        address owner_ = ix.owner();
        _dryRun(op, index, owner_, es);
        // what is about to be signed, field by field (after the dry run: the contract has accepted every field)
        for (uint256 i; i < es.length; ++i) {
            console2.log(describe(es[i]));
        }

        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        if (sender != owner_) {
            vm.stopBroadcast(); // a revert leaves forge's broadcast on in a test; nothing was sent either way
            revert("broadcast with the owner key");
        }
        uint256 day = ix.clocks().day;
        for (uint256 i; i < es.length; ++i) {
            (bool ok, bytes memory err) = index.call(_calldata(op, es[i]));
            if (!ok) revert(string.concat("OwnerAction: ", es[i].label, " reverted: ", _why(ix, err)));
            _report(op, ix, es[i], day);
        }
        vm.stopBroadcast();
    }

    /// Per entry: its id, queuedEta, the window's end and "not queued / waiting N s / executable until T / expired".
    function statusOf(address index, string memory json) public returns (string[] memory lines) {
        IAgateIndex ix = IAgateIndex(index);
        Entry[] memory es = parse(json);
        _checkIds(ix, es);
        uint256 day = ix.clocks().day;
        address owner_ = ix.owner();
        lines = new string[](es.length);
        for (uint256 i; i < es.length; ++i) {
            Entry memory e = es[i];
            uint256 eta = ix.queuedEta(e.id);
            string memory st;
            string memory end = "-";
            if (eta != 0) {
                uint256 dl = eta + ACTION_WINDOW_DAYS * day;
                end = vm.toString(dl);
                st = block.timestamp < eta
                    ? string.concat("waiting ", vm.toString(eta - block.timestamp), " s")
                    : string.concat("executable until ", vm.toString(dl));
            } else {
                // queuedEta hides an expired entry: an execute tried as the owner, then thrown away, tells
                uint256 snap = vm.snapshotState();
                vm.prank(owner_);
                (bool ok, bytes memory err) = index.call(_calldata(Op.EXECUTE, e));
                vm.revertToState(snap);
                if (!ok && bytes4(err) == IAgateIndex.ActionExpired.selector) {
                    (, uint64 dl) = abi.decode(_args(err), (bytes32, uint64));
                    end = vm.toString(dl);
                    st = "expired";
                } else {
                    st = string.concat("not queued", e.isReader ? _executedNote(ix, e) : "");
                }
            }
            lines[i] = string.concat(
                e.label, ": id ", vm.toString(e.id), ", queuedEta ", vm.toString(eta), ", window end ", end, ": ", st
            );
            console2.log(lines[i]);
            console2.log(describe(e));
        }
    }

    /// One entry's fields as the file gives them. Text outside printable ASCII is shown as its hex.
    function describe(Entry memory e) public pure returns (string memory) {
        if (e.isReader) {
            return string.concat(
                "  ",
                e.label,
                ": gpuId ",
                vm.toString(e.gpuId),
                ", url ",
                _shown(e.reader.url),
                ", parserVersion ",
                _shown(e.reader.parserVersion),
                ", reason ",
                _shown(e.reason)
            );
        }
        IAgateIndex.Action memory a = e.action;
        return string.concat(
            "  ",
            e.label,
            ": addr ",
            vm.toString(a.addr),
            ", gpuId ",
            vm.toString(a.gpuId),
            ", slot ",
            vm.toString(a.slot),
            ", day ",
            vm.toString(a.day),
            ", mode ",
            vm.toString(uint256(a.mode))
        );
    }

    function _shown(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i; i < b.length; ++i) {
            if (uint8(b[i]) < 0x20 || uint8(b[i]) > 0x7e) return string.concat("(not printable) ", vm.toString(b));
        }
        return string.concat('"', s, '"');
    }

    // ------------------------------------------------------------------ the file

    function parse(string memory json) public view returns (Entry[] memory es) {
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".actions[", vm.toString(n), "]"))) ++n;
        require(n > 0, "OwnerAction: the file lists no actions");
        es = new Entry[](n);
        for (uint256 i; i < n; ++i) {
            es[i] = _entry(json, i);
        }
    }

    function _entry(string memory json, uint256 i) internal view returns (Entry memory e) {
        string memory k = string.concat(".actions[", vm.toString(i), "]");
        string memory pre = string.concat("OwnerAction: entry ", vm.toString(i));
        require(vm.keyExistsJson(json, string.concat(k, ".kind")), string.concat(pre, ": no kind"));
        string memory kind = vm.parseJsonString(json, string.concat(k, ".kind"));
        (uint256 used, bool isReader, IAgateIndex.ActionKind ak) = _kind(kind, pre);
        // exactly the kind's fields, every one present
        string[] memory keys = vm.parseJsonKeys(json, k);
        uint256 seen;
        for (uint256 j; j < keys.length; ++j) {
            bytes memory kb = bytes(keys[j]);
            if (_eq(keys[j], "kind") || (kb.length != 0 && kb[0] == "_")) continue;
            uint256 bit = _bit(keys[j]);
            if (bit == 0) revert(string.concat(pre, " (", kind, "): unknown field ", keys[j]));
            if (used & bit == 0) revert(string.concat(pre, " (", kind, "): ", keys[j], " is not a field of ", kind));
            seen |= bit;
        }
        if (seen != used) revert(string.concat(pre, " (", kind, "): a field is missing (", _names(used & ~seen), ")"));

        e.isReader = isReader;
        if (used & F_SLOT != 0) e.slot = uint8(_uint(json, string.concat(k, ".slot"), type(uint8).max, pre));
        if (used & F_GPU != 0) e.gpuId = vm.parseJsonBytes32(json, string.concat(k, ".gpuId"));
        e.label = string.concat(
            "entry ",
            vm.toString(i),
            " (",
            kind,
            used & F_SLOT != 0 ? string.concat(" slot ", vm.toString(e.slot)) : "",
            ")"
        );
        if (isReader) {
            e.reader.url = vm.parseJsonString(json, string.concat(k, ".url"));
            e.reader.parserVersion = vm.parseJsonString(json, string.concat(k, ".parserVersion"));
            e.reason = vm.parseJsonString(json, string.concat(k, ".reason"));
            e.id = keccak256(
                abi.encode(
                    READER_SWAP_TAG, e.gpuId, e.slot, keccak256(abi.encode(e.reader.url, e.reader.parserVersion))
                )
            );
        } else {
            e.action.kind = ak;
            e.action.slot = e.slot;
            e.action.gpuId = e.gpuId;
            if (used & F_ADDR != 0) e.action.addr = vm.parseJsonAddress(json, string.concat(k, ".addr"));
            if (used & F_DAY != 0) e.action.day = uint32(_uint(json, string.concat(k, ".day"), type(uint32).max, pre));
            if (used & F_MODE != 0) {
                e.action.mode = IAgateIndex.WriterMode(_uint(json, string.concat(k, ".mode"), 1, pre));
            }
            e.id = keccak256(abi.encode(e.action));
        }
    }

    function _kind(string memory kind, string memory pre)
        internal
        pure
        returns (uint256 used, bool isReader, IAgateIndex.ActionKind ak)
    {
        if (_eq(kind, "READER")) return (F_GPU | F_SLOT | F_URL | F_PARSER | F_REASON, true, ak);
        if (_eq(kind, "WRITER")) return (F_SLOT | F_ADDR, false, IAgateIndex.ActionKind.WRITER);
        if (_eq(kind, "ATTESTER")) return (F_ADDR, false, IAgateIndex.ActionKind.ATTESTER);
        if (_eq(kind, "GUARDIAN")) return (F_SLOT | F_ADDR, false, IAgateIndex.ActionKind.GUARDIAN);
        if (_eq(kind, "FORWARDER")) return (F_ADDR | F_MODE, false, IAgateIndex.ActionKind.FORWARDER);
        if (_eq(kind, "LIVE_FROM")) return (F_GPU | F_SLOT | F_DAY, false, IAgateIndex.ActionKind.LIVE_FROM);
        if (_eq(kind, "LIVE_UNTIL")) return (F_GPU | F_SLOT | F_DAY, false, IAgateIndex.ActionKind.LIVE_UNTIL);
        if (_eq(kind, "OWNER")) return (F_ADDR, false, IAgateIndex.ActionKind.OWNER);
        revert(string.concat(pre, ": unknown kind ", kind));
    }

    function _bit(string memory f) internal pure returns (uint256) {
        if (_eq(f, "slot")) return F_SLOT;
        if (_eq(f, "addr")) return F_ADDR;
        if (_eq(f, "gpuId")) return F_GPU;
        if (_eq(f, "day")) return F_DAY;
        if (_eq(f, "mode")) return F_MODE;
        if (_eq(f, "url")) return F_URL;
        if (_eq(f, "parserVersion")) return F_PARSER;
        if (_eq(f, "reason")) return F_REASON;
        return 0;
    }

    function _names(uint256 bits) internal pure returns (string memory s) {
        string[8] memory n = ["slot", "addr", "gpuId", "day", "mode", "url", "parserVersion", "reason"];
        for (uint256 i; i < 8; ++i) {
            if (bits >> i & 1 == 1) s = bytes(s).length == 0 ? n[i] : string.concat(s, ", ", n[i]);
        }
    }

    function _uint(string memory json, string memory key, uint256 max, string memory pre)
        internal
        pure
        returns (uint256 v)
    {
        v = vm.parseJsonUint(json, key);
        if (v > max) revert(string.concat(pre, ": ", key, " out of range"));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    // ------------------------------------------------------------------ internals

    /// The script's ids must be the chain's: a mismatch means the script and the index disagree on the encoding.
    function _checkIds(IAgateIndex ix, Entry[] memory es) internal pure {
        for (uint256 i; i < es.length; ++i) {
            Entry memory e = es[i];
            bytes32 chainId_ = e.isReader ? ix.readerSwapId(e.gpuId, e.slot, e.reader) : ix.actionId(e.action);
            require(chainId_ == e.id, string.concat("OwnerAction: ", e.label, ": the index computes another id"));
        }
    }

    /// Every entry, in order, as the owner, on a snapshot that is thrown away. The first refusal stops the run.
    function _dryRun(Op op, address index, address owner_, Entry[] memory es) internal {
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < es.length; ++i) {
            vm.prank(owner_);
            (bool ok, bytes memory err) = index.call(_calldata(op, es[i]));
            // the revert also discards the snapshot's changes
            if (!ok) {
                revert(
                    string.concat(
                        "OwnerAction: ",
                        es[i].label,
                        " would revert: ",
                        _why(IAgateIndex(index), err),
                        "; nothing was sent"
                    )
                );
            }
        }
        vm.revertToState(snap);
    }

    function _calldata(Op op, Entry memory e) internal pure returns (bytes memory) {
        if (e.isReader) {
            if (op == Op.QUEUE) {
                return abi.encodeCall(IAgateIndex.queueReaderSwap, (e.gpuId, e.slot, e.reader, e.reason));
            }
            if (op == Op.EXECUTE) return abi.encodeCall(IAgateIndex.executeReaderSwap, (e.gpuId, e.slot, e.reader));
            return abi.encodeCall(IAgateIndex.cancelReaderSwap, (e.gpuId, e.slot, e.reader));
        }
        if (op == Op.QUEUE) return abi.encodeCall(IAgateIndex.queue, (e.action));
        if (op == Op.EXECUTE) return abi.encodeCall(IAgateIndex.execute, (e.action));
        return abi.encodeCall(IAgateIndex.cancel, (e.action));
    }

    function _report(Op op, IAgateIndex ix, Entry memory e, uint256 day) internal view {
        if (op == Op.QUEUE) {
            uint256 eta = ix.queuedEta(e.id);
            console2.log(
                string.concat(
                    "queued ",
                    e.label,
                    ": id ",
                    vm.toString(e.id),
                    ", eta ",
                    vm.toString(eta),
                    ", executable until ",
                    vm.toString(eta + ACTION_WINDOW_DAYS * day),
                    " (by the simulation's clock: the chain's eta can be a block later; status() reads it)"
                )
            );
        } else if (op == Op.EXECUTE) {
            console2.log(
                string.concat("executed ", e.label, ": id ", vm.toString(e.id), e.isReader ? _executedNote(ix, e) : "")
            );
        } else {
            console2.log(string.concat("cancelled ", e.label, ": id ", vm.toString(e.id)));
        }
    }

    /// For a reader: the newest executed swap of the slot with this reader, if any.
    function _executedNote(IAgateIndex ix, Entry memory e) internal view returns (string memory) {
        IAgateIndex.ReaderVersion[] memory h = ix.readerHistory(e.gpuId, e.slot);
        bytes32 rh = keccak256(abi.encode(e.reader.url, e.reader.parserVersion));
        for (uint256 j = h.length; j > 0; --j) {
            if (h[j - 1].readerHash == rh) {
                return string.concat(" (executed: fromDay ", vm.toString(h[j - 1].fromDay), ")");
            }
        }
        return "";
    }

    function _args(bytes memory err) internal pure returns (bytes memory a) {
        a = new bytes(err.length - 4);
        for (uint256 i; i < a.length; ++i) {
            a[i] = err[i + 4];
        }
    }

    /// The index's error, named; the times in it as unix seconds.
    function _why(IAgateIndex ix, bytes memory err) internal view returns (string memory) {
        if (err.length < 4) return string.concat("revert ", vm.toString(err));
        bytes4 sel = bytes4(err);
        if (sel == IAgateIndex.NotQueued.selector) return "NotQueued (never queued, or executed, or cancelled)";
        if (sel == IAgateIndex.TimelockActive.selector) {
            uint64 eta = abi.decode(_args(err), (uint64));
            return string.concat(
                "TimelockActive: executable from ", vm.toString(eta), " (in ", vm.toString(eta - block.timestamp), " s)"
            );
        }
        if (sel == IAgateIndex.ActionExpired.selector) {
            (, uint64 dl) = abi.decode(_args(err), (bytes32, uint64));
            return string.concat(
                "ActionExpired: its window ended at ", vm.toString(dl), "; queue it again (a new timelock)"
            );
        }
        if (sel == IAgateIndex.AlreadyQueued.selector) {
            bytes32 id = abi.decode(_args(err), (bytes32));
            uint256 eta = ix.queuedEta(id);
            return string.concat(
                "AlreadyQueued: live, eta ",
                vm.toString(eta),
                ", executable until ",
                vm.toString(eta + ACTION_WINDOW_DAYS * ix.clocks().day)
            );
        }
        bytes4[15] memory s = [
            IAgateIndex.NotOwner.selector,
            IAgateIndex.BadReader.selector,
            IAgateIndex.BadAction.selector,
            IAgateIndex.ReaderSwapPending.selector,
            IAgateIndex.UnknownGpu.selector,
            IAgateIndex.BadSlot.selector,
            IAgateIndex.DayBegun.selector,
            IAgateIndex.LiveFromTooLate.selector,
            IAgateIndex.LiveFromNotFirstOfMonth.selector,
            IAgateIndex.LiveUntilTooEarly.selector,
            IAgateIndex.SlotAlreadyStarted.selector,
            IAgateIndex.SlotWindowNotOpen.selector,
            IAgateIndex.RoleTaken.selector,
            IAgateIndex.HasCode.selector,
            IAgateIndex.ZeroAddress.selector
        ];
        string[15] memory n = [
            "NotOwner",
            "BadReader",
            "BadAction",
            "ReaderSwapPending",
            "UnknownGpu",
            "BadSlot",
            "DayBegun",
            "LiveFromTooLate",
            "LiveFromNotFirstOfMonth",
            "LiveUntilTooEarly",
            "SlotAlreadyStarted",
            "SlotWindowNotOpen",
            "RoleTaken",
            "HasCode",
            "ZeroAddress"
        ];
        for (uint256 i; i < 15; ++i) {
            if (sel == s[i]) return string.concat(n[i], " ", vm.toString(err));
        }
        return string.concat("revert ", vm.toString(err));
    }
}
