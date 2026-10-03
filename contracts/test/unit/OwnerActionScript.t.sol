// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex, NEVER, ACTION_WINDOW_DAYS} from "../../src/interfaces/IAgateIndex.sol";
import {OwnerAction} from "../../script/OwnerAction.s.sol";

/// OwnerAction with its three variables under other names: tests share one process environment, and the real
/// AGATE_OWNER_KEY belongs to DeployIndexScriptTest.
contract OwnerActionHarness is OwnerAction {
    string internal kv;
    string internal iv;
    string internal fv;

    constructor(string memory k, string memory i, string memory f) {
        (kv, iv, fv) = (k, i, f);
    }

    function _keyVar() internal view override returns (string memory) {
        return kv;
    }

    function _indexVar() internal view override returns (string memory) {
        return iv;
    }

    function _fileVar() internal view override returns (string memory) {
        return fv;
    }

    function _shaVar() internal view override returns (string memory) {
        return string.concat(fv, "_SHA256");
    }

    function fileRef() external view returns (string memory) {
        return _fileRef();
    }
}

/// BUILD-SPEC 13.3 (Oct 3): OwnerAction.s.sol queues, executes and cancels a file of owner actions and reader swaps,
/// prints their status, and refuses before sending anything when an entry would revert. Run in-process against the
/// test index (TEST clock: DAY 2,400 s, TIMELOCK 4,800 s, window 33,600 s).
contract OwnerActionScriptTest is IndexBase {
    OwnerAction internal oa;
    uint256 internal ownerKey;
    address internal newStandby = makeAddr("newStandby");
    address internal fwd2 = makeAddr("forwarder2");
    string internal constant URL = "https://lambda.ai/service/gpu-cloud";

    function setUp() public {
        Profile memory p = TEST_P();
        p.epochDay = OCT1 + 20; // Oct 21: Dec 1 can still be queued as a LIVE_FROM
        deploy(p, 0);
        registerWith(GPU, _fam(5), _fam1(5), OCT1 + 20, 0x0f); // slot 4 reserved
        registerWith(GPU2, _fam(4), _fam1(4), OCT1 + 20, 0x0f);
        oa = new OwnerAction();
        ownerKey = uint256(keccak256(abi.encodePacked("owner"))); // makeAddr("owner")'s key
        assertEq(vm.addr(ownerKey), owner);
    }

    function _fam(uint256 n) internal pure returns (uint8[] memory f) {
        f = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            f[i] = uint8(i);
        }
    }

    function _fam1(uint256 n) internal pure returns (uint8[] memory q) {
        q = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            q[i] = 1;
        }
    }

    function _q(address a) internal pure returns (string memory) {
        return string.concat('"', vm.toString(a), '"');
    }

    /// A WRITER, a FORWARDER, a LIVE_FROM and two READER entries (one per GPU).
    function _five() internal view returns (string memory) {
        return string.concat(
            '{"actions":[{"kind":"WRITER","slot":1,"addr":',
            _q(newStandby),
            '},{"kind":"FORWARDER","addr":',
            _q(fwd2),
            ',"mode":0},{"kind":"LIVE_FROM","gpuId":"',
            vm.toString(GPU),
            '","slot":4,"day":',
            vm.toString(uint256(DEC1)),
            '},{"kind":"READER","gpuId":"',
            vm.toString(GPU),
            '","slot":3,"url":"',
            URL,
            '","parserVersion":"lambda/2","reason":"redesign since 06 UTC","_note":"a comment"},{"kind":"READER","gpuId":"',
            vm.toString(GPU2),
            '","slot":2,"url":"',
            URL,
            '","parserVersion":"lambda/2","reason":"redesign since 06 UTC"}]}'
        );
    }

    function _send(OwnerAction.Op op, string memory json) internal {
        oa.send(op, address(ix), json, ownerKey);
    }

    function _ids(string memory json) internal view returns (bytes32[] memory ids) {
        OwnerAction.Entry[] memory es = oa.parse(json);
        ids = new bytes32[](es.length);
        for (uint256 i; i < es.length; ++i) {
            ids[i] = es[i].id;
        }
    }

    function _contains(string memory s, string memory sub) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(sub);
        if (b.length > a.length) return false;
        for (uint256 i; i + b.length <= a.length; ++i) {
            bool m = true;
            for (uint256 j; j < b.length && m; ++j) {
                m = a[i + j] == b[j];
            }
            if (m) return true;
        }
        return false;
    }

    function _w() internal view returns (uint256) {
        return ACTION_WINDOW_DAYS * uint256(P.day);
    }

    // ------------------------------------------------------------------ the happy path

    function test_ownerAction_queueExecuteCancelStatus() public {
        string memory json = _five();
        bytes32[] memory ids = _ids(json);
        string[] memory st = oa.statusOf(address(ix), json);
        assertEq(st.length, 5);
        for (uint256 i; i < 5; ++i) {
            assertTrue(_contains(st[i], ": not queued"), st[i]);
            assertTrue(_contains(st[i], vm.toString(ids[i])), "the id is printed");
        }
        assertTrue(_contains(st[3], "entry 3 (READER slot 3)"), st[3]);

        _send(OwnerAction.Op.QUEUE, json);
        uint256 eta = block.timestamp + 2 * uint256(P.day);
        for (uint256 i; i < 5; ++i) {
            assertEq(ix.queuedEta(ids[i]), eta);
        }
        st = oa.statusOf(address(ix), json);
        assertTrue(_contains(st[0], "waiting 4800 s"), st[0]);
        assertTrue(_contains(st[0], string.concat("window end ", vm.toString(eta + _w()))), st[0]);

        vm.warp(eta);
        st = oa.statusOf(address(ix), json);
        assertTrue(_contains(st[4], string.concat("executable until ", vm.toString(eta + _w()))), st[4]);
        _send(OwnerAction.Op.EXECUTE, json);
        assertEq(ix.writers()[1], newStandby);
        (address f,) = ix.forwarder();
        assertEq(f, fwd2);
        (uint32 lf,) = ix.slotWindow(GPU, 4);
        assertEq(lf, DEC1);
        IAgateIndex.ReaderVersion[] memory h = ix.readerHistory(GPU, 3);
        assertEq(h.length, 1);
        assertEq(h[0].url, URL);
        assertEq(h[0].reason, "redesign since 06 UTC");
        assertEq(h[0].fromDay, today() + 1);
        assertEq(ix.readerHistory(GPU2, 2).length, 1);
        st = oa.statusOf(address(ix), json);
        assertTrue(_contains(st[0], ": not queued"), st[0]);
        assertTrue(
            _contains(st[3], string.concat("not queued (executed: fromDay ", vm.toString(today() + 1), ")")), st[3]
        );

        // cancel: an ATTESTER and a READER queued, then both cancelled
        string memory two = string.concat(
            '{"actions":[{"kind":"ATTESTER","addr":',
            _q(keeper),
            '},{"kind":"READER","gpuId":"',
            vm.toString(GPU),
            '","slot":1,"url":"https://lambda.ai/pricing","parserVersion":"lambda/3","reason":"r"}]}'
        );
        bytes32[] memory ids2 = _ids(two);
        _send(OwnerAction.Op.QUEUE, two);
        assertGt(ix.queuedEta(ids2[0]), 0);
        assertGt(ix.queuedEta(ids2[1]), 0);
        _send(OwnerAction.Op.CANCEL, two);
        assertEq(ix.queuedEta(ids2[0]), 0);
        assertEq(ix.queuedEta(ids2[1]), 0);
        assertEq(ix.attester(), att);
    }

    // ------------------------------------------------------------------ refusals, nothing sent

    function test_ownerAction_refusesBeforeEtaAndAfterWindow_withoutSending() public {
        string memory json = _five();
        bytes32[] memory ids = _ids(json);
        _send(OwnerAction.Op.QUEUE, json);
        uint256 eta = block.timestamp + 2 * uint256(P.day);
        // a second queue of live entries: refused at the first, naming it
        vm.expectRevert(
            bytes(
                string.concat(
                    "OwnerAction: entry 0 (WRITER slot 1) would revert: AlreadyQueued: live, eta ",
                    vm.toString(eta),
                    ", executable until ",
                    vm.toString(eta + _w()),
                    "; nothing was sent"
                )
            )
        );
        _send(OwnerAction.Op.QUEUE, json);
        // before eta
        vm.warp(eta - 1);
        vm.expectRevert(
            bytes(
                string.concat(
                    "OwnerAction: entry 0 (WRITER slot 1) would revert: TimelockActive: executable from ",
                    vm.toString(eta),
                    " (in 1 s); nothing was sent"
                )
            )
        );
        _send(OwnerAction.Op.EXECUTE, json);
        assertEq(ix.writers()[1], w2, "nothing sent");
        // after the window
        vm.warp(eta + _w() + 1);
        vm.expectRevert(
            bytes(
                string.concat(
                    "OwnerAction: entry 0 (WRITER slot 1) would revert: ActionExpired: its window ended at ",
                    vm.toString(eta + _w()),
                    "; queue it again (a new timelock); nothing was sent"
                )
            )
        );
        _send(OwnerAction.Op.EXECUTE, json);
        assertEq(ix.writers()[1], w2);
        assertEq(ix.readerHistory(GPU, 3).length, 0);
        string[] memory st = oa.statusOf(address(ix), json);
        for (uint256 i; i < 5; ++i) {
            assertTrue(_contains(st[i], string.concat("window end ", vm.toString(eta + _w()), ": expired")), st[i]);
            assertEq(ix.queuedEta(ids[i]), 0);
        }
        // a later entry that would revert stops the whole run, the earlier ones included (nothing sent)
        string memory mixed = string.concat(
            '{"actions":[{"kind":"ATTESTER","addr":',
            _q(keeper),
            '},{"kind":"READER","gpuId":"',
            vm.toString(GPU),
            '","slot":9,"url":"',
            URL,
            '","parserVersion":"lambda/2","reason":"r"}]}'
        );
        vm.expectRevert(
            bytes(
                string.concat(
                    "OwnerAction: entry 1 (READER slot 9) would revert: BadSlot ",
                    vm.toString(abi.encodeWithSelector(IAgateIndex.BadSlot.selector, uint8(9))),
                    "; nothing was sent"
                )
            )
        );
        _send(OwnerAction.Op.QUEUE, mixed);
        assertEq(ix.queuedEta(_ids(mixed)[0]), 0, "the first entry was not queued either");
        // expired entries can still be cancelled
        _send(OwnerAction.Op.CANCEL, json);
        vm.expectRevert(
            bytes(
                "OwnerAction: entry 0 (WRITER slot 1) would revert: NotQueued (never queued, or executed, or cancelled); nothing was sent"
            )
        );
        _send(OwnerAction.Op.CANCEL, json);
    }

    function test_ownerAction_refusesANonOwnerKey() public {
        vm.expectRevert(bytes("broadcast with the owner key"));
        oa.send(OwnerAction.Op.QUEUE, address(ix), _five(), uint256(keccak256("a stranger")));
        assertEq(ix.queuedEta(_ids(_five())[0]), 0);
    }

    // ------------------------------------------------------------------ the environment (fail closed)

    function test_ownerAction_failsClosedKeyAndIndex() public {
        OwnerActionHarness h = new OwnerActionHarness("OA_T1_KEY", "OA_T1_INDEX", "OA_T1_FILE");
        // the key first: set but not a key
        vm.setEnv("OA_T1_KEY", "0x");
        vm.expectRevert(bytes("OA_T1_KEY is set but is not a nonzero 0x-prefixed hex key"));
        h.queue();
        vm.setEnv("OA_T1_KEY", vm.toString(bytes32(ownerKey)));
        // the index: unset, not an address, zero, no code
        vm.expectRevert(bytes("OA_T1_INDEX is not set (the index address)"));
        h.queue();
        vm.expectRevert(bytes("OA_T1_INDEX is not set (the index address)"));
        h.status();
        string[4] memory bad = ["", "0x12", vm.toString(address(0)), vm.toString(makeAddr("no code"))];
        for (uint256 i; i < bad.length; ++i) {
            vm.setEnv("OA_T1_INDEX", bad[i]);
            vm.expectRevert(bytes("OA_T1_INDEX is set but is not an address with code"));
            h.queue();
        }
        vm.setEnv("OA_T1_INDEX", vm.toString(address(ix)));
        // the file: unset, empty
        vm.expectRevert(bytes("OA_T1_FILE is not set (the action file)"));
        h.queue();
        vm.setEnv("OA_T1_FILE", "");
        vm.expectRevert(bytes("OA_T1_FILE is empty"));
        h.queue();
        // all set: the fixture file (a path), then inline JSON
        vm.setEnv("OA_T1_FILE", "test/vectors/owner_action_example.json");
        h.queue();
        bytes32[] memory ids = _ids(vm.readFile("test/vectors/owner_action_example.json"));
        assertEq(ix.queuedEta(ids[0]), block.timestamp + 2 * uint256(P.day));
        assertEq(ix.queuedEta(ids[1]), block.timestamp + 2 * uint256(P.day));
        h.status();
        h.cancel();
        assertEq(ix.queuedEta(ids[0]), 0);
        vm.setEnv("OA_T1_FILE", _five());
        h.queue();
        assertGt(ix.queuedEta(_ids(_five())[4]), 0);
    }

    /// Unset, the key falls back to the script's sender; here that is not the owner, so nothing is sent.
    function test_ownerAction_unsetKeyUsesSender() public {
        OwnerActionHarness h = new OwnerActionHarness("OA_T2_KEY_UNSET", "OA_T2_INDEX", "OA_T2_FILE");
        vm.setEnv("OA_T2_INDEX", vm.toString(address(ix)));
        vm.setEnv("OA_T2_FILE", "test/vectors/owner_action_example.json");
        vm.expectRevert(bytes("broadcast with the owner key"));
        h.queue();
    }

    // ------------------------------------------------------------------ the file format

    function _parseReverts(string memory json, string memory err) internal {
        vm.expectRevert(bytes(err));
        oa.parse(json);
    }

    function test_ownerAction_refusesUnknownKindAndUnusedField() public {
        string memory a = _q(keeper);
        _parseReverts('{"actions":[]}', "OwnerAction: the file lists no actions");
        _parseReverts('{"other":1}', "OwnerAction: the file lists no actions");
        _parseReverts(
            string.concat('{"actions":[{"kind":"PAUSE","addr":', a, "}]}"), "OwnerAction: entry 0: unknown kind PAUSE"
        );
        _parseReverts(string.concat('{"actions":[{"addr":', a, "}]}"), "OwnerAction: entry 0: no kind");
        // a field the kind does not use, set: refused (the contract's BadAction rule, one effect one id)
        _parseReverts(
            string.concat('{"actions":[{"kind":"WRITER","slot":1,"addr":', a, ',"gpuId":"', vm.toString(GPU), '"}]}'),
            "OwnerAction: entry 0 (WRITER): gpuId is not a field of WRITER"
        );
        _parseReverts(
            string.concat('{"actions":[{"kind":"ATTESTER","addr":', a, ',"mode":0}]}'),
            "OwnerAction: entry 0 (ATTESTER): mode is not a field of ATTESTER"
        );
        _parseReverts(
            string.concat('{"actions":[{"kind":"OWNER","addr":', a, ',"slot":0}]}'),
            "OwnerAction: entry 0 (OWNER): slot is not a field of OWNER"
        );
        _parseReverts(
            string.concat(
                '{"actions":[{"kind":"READER","gpuId":"',
                vm.toString(GPU),
                '","slot":3,"url":"',
                URL,
                '","parserVersion":"lambda/2","reason":"r","addr":',
                a,
                "}]}"
            ),
            "OwnerAction: entry 0 (READER): addr is not a field of READER"
        );
        // a typo and a missing field
        _parseReverts(
            string.concat('{"actions":[{"kind":"WRITER","slot":1,"adr":', a, "}]}"),
            "OwnerAction: entry 0 (WRITER): unknown field adr"
        );
        _parseReverts(
            '{"actions":[{"kind":"WRITER","slot":1}]}', "OwnerAction: entry 0 (WRITER): a field is missing (addr)"
        );
        _parseReverts(
            string.concat('{"actions":[{"kind":"READER","gpuId":"', vm.toString(GPU), '","slot":3}]}'),
            "OwnerAction: entry 0 (READER): a field is missing (url, parserVersion, reason)"
        );
        // out of range
        _parseReverts(
            string.concat('{"actions":[{"kind":"WRITER","slot":256,"addr":', a, "}]}"),
            "OwnerAction: entry 0: .actions[0].slot out of range"
        );
        _parseReverts(
            string.concat('{"actions":[{"kind":"FORWARDER","addr":', a, ',"mode":2}]}'),
            "OwnerAction: entry 0: .actions[0].mode out of range"
        );
        // the second entry is named
        _parseReverts(
            string.concat('{"actions":[{"kind":"ATTESTER","addr":', a, '},{"kind":"ATTESTER","addr":', a, ',"day":1}]}'),
            "OwnerAction: entry 1 (ATTESTER): day is not a field of ATTESTER"
        );
        // unused fields stay zero, so the id is the contract's
        OwnerAction.Entry[] memory es = oa.parse(string.concat('{"actions":[{"kind":"ATTESTER","addr":', a, "}]}"));
        IAgateIndex.Action memory x;
        x.kind = IAgateIndex.ActionKind.ATTESTER;
        x.addr = keeper;
        assertEq(es[0].id, ix.actionId(x));
    }

    /// The repair agent's action file (synthetic fixture, 15.2) parses into READER entries with the contract's ids.
    function test_ownerAction_repairFixtureParses() public view {
        string memory json = vm.readFile("test/vectors/owner_action_example.json");
        OwnerAction.Entry[] memory es = oa.parse(json);
        assertEq(es.length, 2);
        bytes32[2] memory g = [GPU, GPU2];
        uint8[2] memory sl = [3, 2];
        for (uint256 i; i < 2; ++i) {
            assertTrue(es[i].isReader);
            assertEq(es[i].gpuId, g[i]);
            assertEq(es[i].slot, sl[i]);
            assertEq(es[i].reader.url, URL);
            assertEq(es[i].reader.parserVersion, "lambda/2");
            assertTrue(bytes(es[i].reason).length > 0 && bytes(es[i].reason).length <= 280);
            assertEq(es[i].id, ix.readerSwapId(g[i], sl[i], es[i].reader));
        }
        (uint32 lf,) = ix.slotWindow(GPU, 4);
        assertEq(lf, NEVER, "setUp left slot 4 reserved");
    }

    /// 13.3: the command the operator runs (the repair agent's notes print the same shape, 15.2): a Keychain read, never
    /// a key, and the key-free public RPC on Monad testnet.
    function test_ownerAction_printsTheOperatorsCommand() public {
        string memory file = "/Users/x/.agate-wall/repair/actions/inc-1-0123abcd.json";
        string memory idx = vm.toString(address(ix));
        vm.chainId(10_143);
        assertEq(
            oa.command("queue()", address(ix), file),
            string.concat(
                'AGATE_OWNER_KEY="$(security find-generic-password -s agate.wall.owner -a private-key -w)" AGATE_INDEX=',
                idx,
                " AGATE_OWNER_ACTION=",
                file,
                " forge script script/OwnerAction.s.sol --sig 'queue()' --rpc-url https://testnet-rpc.monad.xyz --broadcast"
            )
        );
        assertEq(
            oa.command("status()", address(ix), file),
            string.concat(
                "AGATE_INDEX=",
                idx,
                " AGATE_OWNER_ACTION=",
                file,
                " forge script script/OwnerAction.s.sol --sig 'status()' --rpc-url https://testnet-rpc.monad.xyz"
            )
        );
        vm.chainId(31_337);
        assertTrue(
            _contains(oa.command("execute()", address(ix), file), "--sig 'execute()' --rpc-url <rpc url> --broadcast")
        );
    }

    /// Fix round (audit L1, L2): forge reads only the repo's folders, so a file outside it is refused with the
    /// shell form to use; AGATE_OWNER_ACTION_SHA256 pins the JSON; every entry's fields are printed before a send.
    function test_ownerAction_outsideFileRefused_shaPinned_fieldsShown() public {
        OwnerActionHarness h = new OwnerActionHarness("OA_T9_KEY", "OA_T9_INDEX", "OA_T9_FILE");
        vm.setEnv("OA_T9_KEY", vm.toString(bytes32(ownerKey)));
        vm.setEnv("OA_T9_INDEX", vm.toString(address(ix)));
        // a path outside the repo (the repair agent's home): refused, nothing sent, the hint names the shell form
        vm.setEnv("OA_T9_FILE", "/etc/hosts");
        vm.expectRevert(
            bytes(
                "OA_T9_FILE: forge may not read /etc/hosts (only the repo's folders); pass its JSON: OA_T9_FILE=\"$(cat '/etc/hosts')\""
            )
        );
        h.queue();
        assertEq(h.fileRef(), "\"$(cat '/etc/hosts')\"");
        // the JSON itself, pinned by its sha256
        vm.setEnv("OA_T9_FILE", vm.readFile("test/vectors/owner_action_example.json"));
        string memory json = vm.envString("OA_T9_FILE"); // as forge reads it back (the shell's $(cat) drops the last newline)
        assertEq(h.fileRef(), "\"$(cat '<the same action file>')\"");
        vm.setEnv("OA_T9_FILE_SHA256", vm.toString(sha256(bytes("{}"))));
        vm.expectRevert(
            bytes(
                string.concat(
                    "OA_T9_FILE_SHA256: the action JSON changed since the note (sha256 ",
                    vm.toString(sha256(bytes(json))),
                    ")"
                )
            )
        );
        h.queue();
        vm.setEnv("OA_T9_FILE_SHA256", "0x12");
        vm.expectRevert(bytes("OA_T9_FILE_SHA256 is set but is not a sha256 in hex"));
        h.queue();
        // the note prints it without 0x (so no key-shaped 0x value is ever in a note); either form is accepted
        string memory hex64 = vm.replace(vm.toString(sha256(bytes(json))), "0x", "");
        vm.setEnv("OA_T9_FILE_SHA256", hex64);
        h.queue();
        bytes32[] memory ids = _ids(json);
        assertEq(ix.queuedEta(ids[0]), block.timestamp + 2 * uint256(P.day));
        // the fields the operator signs
        OwnerAction.Entry[] memory es = oa.parse(json);
        string memory d = oa.describe(es[0]);
        assertTrue(_contains(d, ", url \"https://"), d);
        assertTrue(_contains(d, ", parserVersion \""), d);
        assertTrue(_contains(d, ", reason \""), d);
        // text outside printable ASCII is shown as hex, never raw
        es[0].reason = string(abi.encodePacked("x", bytes1(0x1b), "[2J"));
        assertTrue(_contains(oa.describe(es[0]), ", reason (not printable) 0x781b5b324a"));
    }
}
