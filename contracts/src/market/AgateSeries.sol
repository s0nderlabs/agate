// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IAgateIndex} from "../interfaces/IAgateIndex.sol";
import {IAgateSeries} from "./interfaces/IAgateSeries.sol";
import {IAgateToken} from "./interfaces/IAgateToken.sol";
import {AgateToken} from "./AgateToken.sol";
import {LastResortLib} from "./lib/LastResortLib.sol";
import {
    U,
    LOT,
    GRID,
    FIX_CALL_GAS,
    SYNC_ROUND_GAS,
    MAX_Q,
    FLAG_LATE,
    FLAG_INCOMPLETE,
    FLAG_FORCED,
    FLAG_BELOW_FLOOR,
    FLAG_ABOVE_CAP,
    FLAG_CARRIED,
    Side,
    CloseKind,
    BandGrade,
    SeriesTerms,
    Position
} from "./MarketTypes.sol";

/// @title AgateSeries: one GPU, one month (BUILD-SPEC 4)
/// @notice A pair (one token plus one short unit) is worth exactly C. The token pays S / N per token after the
/// month, a short unit C - S / N; positions pay both sides daily. No owner, no proxy, no pause, no admin; every term
/// immutable. Payouts are checked only against `ledger`, never against a balance.
/// @dev Every write is nonReentrant, but the views are consistent only between calls: with a dollar that has transfer
/// hooks, a hook inside mint or unstream sees the short credited before the dollar pull (audit L2). Integrators must
/// not read series views from inside a dollar hook; tUSD and Kuru's USDC have none.
contract AgateSeries is IAgateSeries, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// A round for an ended day needs this much gas left (4.6): the index call then gets its full FIX_CALL_GAS.
    uint256 internal constant ROUND_RESERVE = FIX_CALL_GAS * 64 / 63 + SYNC_ROUND_GAS;

    // ------------------------------------------------------------------ terms (BUILD-SPEC 4.4)

    address internal immutable INDEX;
    address internal immutable DOLLAR;
    address internal immutable FACTORY;
    address internal immutable ROUTER;
    bytes32 internal immutable GPU_ID;
    bytes32 internal immutable RECIPE_HASH;
    uint32 internal immutable MONTH;
    uint32 internal immutable START_DAY;
    uint8 internal immutable N;
    uint64 internal immutable START_TS;
    uint32 internal immutable DAY;
    uint64 internal immutable LAST_RESORT;
    uint32 internal immutable F;
    uint32 internal immutable C;
    uint32 internal immutable X0;
    BandGrade internal immutable BAND_GRADE;
    uint8 internal immutable ANCHOR_CARRIED;
    uint8 internal immutable ANCHOR_MIN_FRESH;
    bool internal immutable ANCHOR_LATE;
    address internal immutable TOKEN;
    uint256 internal immutable K; // C - F

    // ------------------------------------------------------------------ state (BUILD-SPEC 4.4)

    // k .. ledger share one slot (8 + 64 + 32 + 8 + 8 + 128 = 248 bits)
    uint8 internal k;
    uint64 internal S;
    uint32 internal lastX;
    bool internal walked;
    bool internal appliedReal;
    uint128 internal ledger;
    uint256 internal nextId;
    uint256 internal shortSupply;
    mapping(address => uint256) internal shorts;
    mapping(uint256 => Position) internal positions;

    /// The sync state while a sync (or its read-only preview) runs; written back once per call.
    struct Cursor {
        uint256 k;
        uint256 s;
        uint32 lastX;
        bool walked;
        bool appliedReal;
    }

    /// Called by a factory (BUILD-SPEC 3.3). The address checks come first so a zero dollar reverts BadTerms
    /// instead of failing inside the decimals() call.
    constructor(SeriesTerms memory t, string memory name_, string memory symbol_) {
        if (t.index == address(0) || t.dollar == address(0) || t.factory == address(0) || t.router == address(0)) {
            revert BadTerms();
        }
        if (IERC20Metadata(t.dollar).decimals() != 6) revert DollarDecimals();
        if (t.floor % GRID != 0 || t.cap % GRID != 0 || t.floor < GRID || t.floor >= t.cap) revert BadBand();
        if (t.n < 28 || t.n > 31 || t.day == 0 || t.lastResort != LastResortLib.lastResort(t.day)) revert BadTerms();

        INDEX = t.index;
        DOLLAR = t.dollar;
        FACTORY = t.factory;
        ROUTER = t.router;
        GPU_ID = t.gpuId;
        RECIPE_HASH = t.recipeHash;
        MONTH = t.month;
        START_DAY = t.startDay;
        N = t.n;
        START_TS = t.startTs;
        DAY = t.day;
        LAST_RESORT = t.lastResort;
        F = t.floor;
        C = t.cap;
        X0 = t.x0;
        BAND_GRADE = t.bandGrade;
        ANCHOR_CARRIED = t.anchorCarried;
        ANCHOR_MIN_FRESH = t.anchorMinFresh;
        ANCHOR_LATE = t.anchorLate;
        K = uint256(t.cap) - t.floor;
        TOKEN = address(new AgateToken(name_, symbol_));

        lastX = t.x0;
        nextId = 1;
    }

    // ================================================================== pairs (4.5): read no fix

    function mint(uint256 q, address to) external nonReentrant returns (uint256 cost) {
        _checkLot(q);
        _okTo(to);
        cost = _mintCost(q);
        _credit(msg.sender, q); // the short side always goes to the payer (I29)
        emit Minted(msg.sender, to, q, cost);
        _take(msg.sender, cost);
        IAgateToken(TOKEN).mint(to, q);
    }

    function redeem(uint256 q, address to) external nonReentrant returns (uint256 paid) {
        _checkLot(q);
        _okTo(to);
        if (IERC20(TOKEN).balanceOf(msg.sender) < q) revert TokenBalance();
        if (shorts[msg.sender] < q) revert ShortBalance();
        paid = q * C / U;
        _debit(msg.sender, q);
        emit Redeemed(msg.sender, to, q, paid);
        _burn(q);
        _pay(to, paid);
    }

    // ================================================================== positions (4.5)

    function streamOut(Side side, uint256 q, address owner, address payee, address to, bool daily)
        external
        nonReentrant
        returns (uint256 id, uint256 paidNow)
    {
        (, uint256 k_, uint256 s_) = _sync(type(uint256).max);
        if (k_ >= N) revert MonthFinal();
        if (q == 0 || q % LOT != 0 || q > MAX_Q) revert BadAmount();
        if (owner == address(0) || owner == address(this) || owner == TOKEN || owner == ROUTER || owner == FACTORY) {
            revert BadOwner();
        }
        // only the factory's router may turn a short into a position owned by someone else (I29)
        if (side == Side.SHORT && owner != msg.sender && msg.sender != ROUTER) revert BadOwner();
        _okPayee(payee);
        _okTo(to);
        if (side == Side.LONG) {
            if (IERC20(TOKEN).balanceOf(msg.sender) < q) revert TokenBalance();
        } else if (shorts[msg.sender] < q) {
            revert ShortBalance();
        }

        paidNow = _owed(side, q, k_, s_);
        if (side == Side.SHORT) _debit(msg.sender, q);
        id = nextId++;
        address operator = msg.sender == owner ? address(0) : msg.sender;
        positions[id] = Position({
            owner: owner,
            side: side,
            daily: daily,
            openedK: uint8(k_),
            payee: payee,
            q: uint64(q),
            operator: operator,
            paid: uint96(paidNow)
        });
        emit PositionOpened(id, owner, payee, side, q, paidNow, operator, daily, uint8(k_), to);
        if (side == Side.LONG) _burn(q);
        _pay(to, paidNow);
    }

    function claim(uint256 id) external nonReentrant returns (uint256 paid) {
        (, uint256 k_, uint256 s_) = _sync(type(uint256).max);
        Position storage p = positions[id];
        if (p.owner == address(0)) revert NoPosition(id);
        paid = _claimOne(id, p, k_, s_);
    }

    /// One sync, then every id that has a position; a missing id is skipped, a repeated one pays 0 again.
    function claimMany(uint256[] calldata ids) external nonReentrant returns (uint256 total) {
        (, uint256 k_, uint256 s_) = _sync(type(uint256).max);
        for (uint256 i; i < ids.length; ++i) {
            Position storage p = positions[ids[i]];
            if (p.owner != address(0)) total += _claimOne(ids[i], p, k_, s_);
        }
    }

    function setPayout(uint256 id, address payee, bool daily) external nonReentrant {
        Position storage p = _ownPosition(id);
        _okPayee(payee);
        p.payee = payee;
        p.daily = daily;
        emit PayoutChanged(id, payee, daily);
    }

    function setOperator(uint256 id, address operator) external nonReentrant {
        Position storage p = _ownPosition(id);
        if (operator == p.owner) revert BadOperator();
        p.operator = operator;
        emit OperatorSet(id, operator);
    }

    /// Delivers q of the opposite side: the position plus it is a whole pair, worth q C / U minus what was paid.
    function closeWithToken(uint256 id, address to) external nonReentrant returns (uint256 paid) {
        Position storage p = positions[id];
        address owner = p.owner;
        if (owner == address(0)) revert NoPosition(id);
        address recipient = _closeRecipient(p, to);
        uint256 q = p.q;
        Side side = p.side;
        if (side == Side.SHORT) {
            if (IERC20(TOKEN).balanceOf(msg.sender) < q) revert TokenBalance();
        } else if (shorts[msg.sender] < q) {
            revert ShortBalance();
        }
        paid = q * C / U - p.paid;
        if (side == Side.LONG) _debit(msg.sender, q);
        delete positions[id];
        emit PositionClosed(id, owner, CloseKind.WITH_TOKEN, paid, recipient, msg.sender);
        if (side == Side.SHORT) _burn(q);
        _pay(recipient, paid);
    }

    /// Takes back what the position was paid and returns its q: as if it had never been opened (I7).
    function unstream(uint256 id, address to) external nonReentrant returns (uint256 paidBack) {
        Position storage p = _ownPosition(id);
        address owner = p.owner;
        _okTo(to);
        Side side = p.side;
        if (side == Side.SHORT && to != owner) revert BadRecipient();
        paidBack = _unstreamBack(p);
        uint256 q = p.q;
        if (side == Side.SHORT) _credit(owner, q);
        delete positions[id];
        emit PositionClosed(id, owner, CloseKind.UNSTREAMED, paidBack, to, msg.sender);
        _take(msg.sender, paidBack);
        if (side == Side.LONG) IAgateToken(TOKEN).mint(to, q);
    }

    // ================================================================== after the month (4.5)

    function settle(Side side, uint256 q, address to) external nonReentrant returns (uint256 paid) {
        (, uint256 k_, uint256 s_) = _sync(type(uint256).max);
        uint256 n = N;
        if (k_ != n) revert MonthNotFinal();
        if (q == 0) revert BadAmount();
        _okTo(to);
        uint256 num;
        if (side == Side.LONG) {
            if (IERC20(TOKEN).balanceOf(msg.sender) < q) revert TokenBalance();
            num = s_;
        } else {
            if (shorts[msg.sender] < q) revert ShortBalance();
            num = n * C - s_;
        }
        paid = q * num / (n * U);
        if (side == Side.SHORT) _debit(msg.sender, q);
        emit Settled(msg.sender, side, q, paid, to);
        if (side == Side.LONG) _burn(q);
        _pay(to, paid);
    }

    function sync(uint256 maxDays) external nonReentrant returns (uint256 applied) {
        (applied,,) = _sync(maxDays);
    }

    // ================================================================== views (never revert unless noted)

    function token() external view returns (address) {
        return TOKEN;
    }

    function terms() external view returns (SeriesTerms memory) {
        return SeriesTerms({
            index: INDEX,
            dollar: DOLLAR,
            factory: FACTORY,
            router: ROUTER,
            gpuId: GPU_ID,
            recipeHash: RECIPE_HASH,
            month: MONTH,
            startDay: START_DAY,
            n: N,
            startTs: START_TS,
            day: DAY,
            lastResort: LAST_RESORT,
            floor: F,
            cap: C,
            x0: X0,
            bandGrade: BAND_GRADE,
            anchorCarried: ANCHOR_CARRIED,
            anchorMinFresh: ANCHOR_MIN_FRESH,
            anchorLate: ANCHOR_LATE
        });
    }

    function state() external view returns (uint8, uint64, uint32, bool, bool, uint128, uint256, uint256) {
        return (k, S, lastX, walked, appliedReal, ledger, nextId, shortSupply);
    }

    function shortOf(address account) external view returns (uint256) {
        return shorts[account];
    }

    function position(uint256 id) external view returns (Position memory) {
        return positions[id];
    }

    /// At the stored k, before any pending day is applied.
    function owed(Side side, uint256 q) external view returns (uint256) {
        return _owed(side, q, k, S);
    }

    /// What a sync with enough gas would leave now (RC8: no gas rule in a view).
    function previewSync() external view returns (uint8, uint64) {
        Cursor memory c = _preview();
        return (uint8(c.k), uint64(c.s));
    }

    /// What the next claim would pay; reverts NoPosition.
    function claimable(uint256 id) external view returns (uint256) {
        Position storage p = positions[id];
        if (p.owner == address(0)) revert NoPosition(id);
        Cursor memory c = _preview();
        return _owed(p.side, p.q, c.k, c.s) - p.paid;
    }

    function mintCost(uint256 q) external view returns (uint256) {
        return _mintCost(q);
    }

    function redeemValue(uint256 q) external view returns (uint256) {
        return q * C / U;
    }

    // ================================================================== sync (4.6)

    function _load() internal view returns (Cursor memory) {
        return Cursor({k: k, s: S, lastX: lastX, walked: walked, appliedReal: appliedReal});
    }

    function _sync(uint256 maxDays) internal returns (uint256 applied, uint256 k_, uint256 s_) {
        Cursor memory c = _load();
        uint256 n = N;
        while (c.k < n && applied < maxDays) {
            (bool go, uint32 x, IAgateIndex.Status st, uint8 flags) = _round(c, true);
            if (!go) break;
            (uint32 cl, uint8 fl) = _applyDay(c, x, st, flags);
            emit FixApplied(uint8(c.k), START_DAY + uint32(c.k) - 1, x, cl, st, fl, uint64(c.s));
            ++applied;
        }
        if (applied != 0) {
            k = uint8(c.k);
            S = uint64(c.s);
            lastX = c.lastX;
            walked = c.walked;
            appliedReal = c.appliedReal;
        }
        return (applied, c.k, c.s);
    }

    function _preview() internal view returns (Cursor memory c) {
        c = _load();
        uint256 n = N;
        while (c.k < n) {
            (bool go, uint32 x, IAgateIndex.Status st, uint8 flags) = _round(c, false);
            if (!go) break;
            _applyDay(c, x, st, flags);
        }
    }

    /// The per-day step shared by sync and its preview. Returns go = false where the loop stops silently (a running
    /// day, or an ended day without a final fix before its last resort). `live` applies the gas rule (RC8).
    function _round(Cursor memory c, bool live)
        internal
        view
        returns (bool go, uint32 x, IAgateIndex.Status st, uint8 flags)
    {
        uint256 end = uint256(START_TS) + (c.k + 1) * DAY;
        if (block.timestamp < end) return (false, 0, IAgateIndex.Status.NONE, 0);
        if (live && !_roundGasOk()) revert SyncGasLow();
        (bool ok, uint32 v, IAgateIndex.Status s, bool late, bool incomplete) = _fix(START_DAY + uint32(c.k));
        if (ok) {
            c.appliedReal = true;
            if (late) flags |= FLAG_LATE;
            if (incomplete) flags |= FLAG_INCOMPLETE;
            return (true, v, s, flags);
        }
        if (block.timestamp < end + LAST_RESORT) return (false, 0, IAgateIndex.Status.NONE, 0);
        if (!c.appliedReal && !c.walked) {
            // one walk per series: the newest final value of the 31 days before the month, else x0
            for (uint32 j = 1; j <= 31 && j <= START_DAY; ++j) {
                if (live && !_roundGasOk()) revert SyncGasLow();
                (bool okW, uint32 vW,,,) = _fix(START_DAY - j);
                if (okW) {
                    c.lastX = vW;
                    break;
                }
            }
            c.walked = true;
        }
        return (true, c.lastX, IAgateIndex.Status.NONE, FLAG_FORCED);
    }

    function _applyDay(Cursor memory c, uint32 x, IAgateIndex.Status st, uint8 flags)
        internal
        view
        returns (uint32 cl, uint8 fl)
    {
        uint32 f = F;
        uint32 cap = C;
        cl = x < f ? f : (x > cap ? cap : x);
        fl = flags;
        if (x < f) fl |= FLAG_BELOW_FLOOR;
        if (x > cap) fl |= FLAG_ABOVE_CAP;
        if (st == IAgateIndex.Status.CARRIED) fl |= FLAG_CARRIED;
        c.s += cl;
        c.k += 1;
        c.lastX = x;
    }

    /// A revert or a starved call both read as "no fix"; a malformed return reverts (the index is ours, 4.6).
    function _fix(uint32 d)
        internal
        view
        returns (bool ok, uint32 x, IAgateIndex.Status st, bool late, bool incomplete)
    {
        try IAgateIndex(INDEX).finalFix{gas: FIX_CALL_GAS}(GPU_ID, d) returns (
            bool ok_, uint32 x_, IAgateIndex.Status st_, uint8, bool late_, bool incomplete_
        ) {
            return (ok_, x_, st_, late_, incomplete_);
        } catch {
            return (false, 0, IAgateIndex.Status.NONE, false, false);
        }
    }

    // ================================================================== money and balances (4.4)

    function _claimOne(uint256 id, Position storage p, uint256 k_, uint256 s_) internal returns (uint256 paid) {
        uint256 o = _owed(p.side, p.q, k_, s_);
        paid = o - p.paid;
        address payee = p.payee;
        emit Claimed(id, payee, paid, o, uint8(k_));
        if (k_ == N) {
            address owner = p.owner;
            delete positions[id];
            emit PositionClosed(id, owner, CloseKind.FINAL, paid, payee, msg.sender);
        } else {
            p.paid = uint96(o);
        }
        _pay(payee, paid);
    }

    function _ownPosition(uint256 id) internal view returns (Position storage p) {
        p = positions[id];
        if (p.owner == address(0)) revert NoPosition(id);
        if (msg.sender != p.owner) revert NotOwner();
    }

    function _owed(Side side, uint256 q, uint256 k_, uint256 s_) internal view returns (uint256) {
        if (side == Side.LONG) return q * (s_ + (N - k_) * F) / (uint256(N) * U);
        return _owedShort(q, k_, s_);
    }

    /// Fee-on-transfer dollars are refused: the balance must rise by exactly amt.
    function _take(address from, uint256 amt) internal {
        if (amt == 0) return;
        ledger = SafeCast.toUint128(uint256(ledger) + amt);
        uint256 b0 = IERC20(DOLLAR).balanceOf(address(this));
        IERC20(DOLLAR).safeTransferFrom(from, address(this), amt);
        if (IERC20(DOLLAR).balanceOf(address(this)) != b0 + amt) revert DollarInexact();
    }

    function _pay(address to, uint256 amt) internal {
        ledger = uint128(uint256(ledger) - amt); // checked: never pays beyond the ledger
        if (amt != 0) IERC20(DOLLAR).safeTransfer(to, amt);
    }

    function _credit(address a, uint256 q) internal {
        uint256 bal = shorts[a] + q;
        shorts[a] = bal;
        shortSupply += q;
        emit ShortCredited(a, q, bal);
    }

    /// Every caller (always with a == msg.sender) has already reverted ShortBalance unless shorts[a] >= q, in its own
    /// checks, so this is a plain checked subtraction (one balance check, not two).
    function _debit(address a, uint256 q) internal {
        uint256 bal = shorts[a] - q;
        shorts[a] = bal;
        shortSupply -= q;
        emit ShortDebited(a, q, bal);
    }

    /// The only way the series burns: from msg.sender (I12).
    function _burn(uint256 q) internal {
        IAgateToken(TOKEN).burn(msg.sender, q);
    }

    /// Nothing ever moves a token or a dollar out of the factory or its router (audit L1); only the router names
    /// itself, in its own flows.
    function _okTo(address to) internal view {
        if (
            to == address(0) || to == address(this) || to == TOKEN || to == FACTORY
                || (to == ROUTER && msg.sender != ROUTER)
        ) revert BadRecipient();
    }

    function _okPayee(address p) internal view {
        if (p == address(0) || p == address(this) || p == TOKEN || p == ROUTER || p == FACTORY) revert BadPayee();
    }

    // ================================================================== virtual steps (4.4, for the negative controls)

    /// The short leg of owed, from its own numerator (never as a complement of the long).
    function _owedShort(uint256 q, uint256 k_, uint256 s_) internal view virtual returns (uint256) {
        return q * (k_ * C - s_) / (uint256(N) * U);
    }

    function _mintCost(uint256 q) internal view virtual returns (uint256) {
        return (q * C + U - 1) / U;
    }

    function _checkLot(uint256 q) internal view virtual {
        if (q == 0 || q % LOT != 0) revert BadAmount();
    }

    /// Where a close pays: the owner names any valid recipient, an operator only the owner.
    function _closeRecipient(Position storage p, address to) internal view virtual returns (address) {
        if (msg.sender == p.owner) {
            _okTo(to);
        } else {
            if (p.operator == address(0) || msg.sender != p.operator) revert NotOwnerOrOperator();
            if (to != p.owner) revert OperatorMustPayOwner();
        }
        return to;
    }

    function _unstreamBack(Position storage p) internal view virtual returns (uint256) {
        return p.paid;
    }

    function _roundGasOk() internal view virtual returns (bool) {
        return gasleft() >= ROUND_RESERVE;
    }
}
