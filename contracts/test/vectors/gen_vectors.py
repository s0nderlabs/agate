#!/usr/bin/env python3
"""
gen_vectors.py: differential traces for AgateIndex from the Python reference model (BUILD-SPEC 12.2).

    AGATE_REFERENCE_MODEL=/path/to/reference_model.py python3 test/vectors/gen_vectors.py

The model itself stays outside the repo; the JSON written here is numbers only (test/vectors/diff_*.json).

The model predates v4.2's three contract changes and v4.3's five. This script patches the model the same way
(preferred over dropping calls) and says which:
  v4.2  C1 one-slice CLOSE_GRACE                      close_day
        veto names the record (source and digest)     veto (the model's callers always name the pending one)
        the attester's select needs a complete day    attest
  v4.3  C3 first-writer priority from T_PEND          source_of / close_day
        needsSign = changed or signAll or not first   close_day, attest (countersign and select)
        carry advance (carryPost)                     carry_day
        T_PEND floor with signAll                     Params
        GRACE = DAY, REOPEN_WAIT = DAY / 4            Params
Every public call of the patched model (reports, closes, carries, attests, selects, vetoes, suspensions, owner
actions) is recorded with its outcome and, after each successful state change, the state the contract must have.
Digests are recomputed in Solidity from the recorded fields (the model hashes differently).
"""
import importlib.util
import json
import os
import random
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.environ.get("AGATE_REFERENCE_MODEL")
if not PATH or not os.path.exists(PATH):
    sys.exit("set AGATE_REFERENCE_MODEL to reference_model.py")
spec = importlib.util.spec_from_file_location("refmodel", PATH)
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

Revert, req, cent = M.Revert, M.req, M.cent
FRESH, HELD, OUT, CARRIED = M.FRESH, M.HELD, M.OUT, M.CARRIED
GPU = M.GPU

# ---------------------------------------------------------------------------------------------- v4.3 patches

_orig_params_init = M.Params.__init__


def _params_init(self, *a, signAll=False, **kw):
    _orig_params_init(self, *a, **kw)
    gap = max(1, self.SLICES // 8)
    floor = gap * self.SLICE + 60
    assert floor <= self.DAY // 2 or signAll, "PEND_FLOOR > DAY/2 needs signAll"
    self.SIGN_ALL = signAll
    self.T_PEND = self.DAY // 4 if (signAll and floor > self.DAY // 2) else max(self.DAY // 4, floor)
    self.CLOSE_GRACE = self.SLICE
    self.GRACE = self.DAY
    self.REOPEN_WAIT = self.DAY // 4


M.Params.__init__ = _params_init


_RecordBase = M.Record


class Record43(_RecordBase):
    __slots__ = ("needs_sign",)

    def __init__(self, **kw):
        for k in _RecordBase.__slots__:
            setattr(self, k, kw.get(k))
        self.needs_sign = kw.get("needs_sign", False)


M.Record = Record43

TRACES = []


class Trace:
    def __init__(self, ix):
        self.ix = ix
        self.ops = []
        self.n = None
        self.mode = len(TRACES) % 2  # 0: direct path, 1: through onReport
        TRACES.append(self)


ROLE_ATT = ("att", "a1")


def idx(ix, name):
    if name is None:
        return 7
    if name == "w1":
        return 0
    if name == "w2":
        return 1
    if name in ROLE_ATT:
        return 2
    if name == "g1":
        return 3
    if name == "g2":
        return 4
    if name == "owner":
        return 5
    return 6


KIND = {OUT: 0, FRESH: 1, HELD: 2}
STATUS = {"FULL": 1, "DEGRADED": 2, "DEMO": 3, "CARRIED": 4}


def fields(ix, g, src, p, kinds, counts, st, value):
    out = [idx(ix, src), value]
    out += list(p) + [KIND[k] for k in kinds] + list(counts)
    out += list(st.e) + list(st.miss) + [int(b) for b in st.inm] + [int(b) for b in st.was]
    return out


def snapshot(ix):
    g = ix.gpus[GPU]
    h = g.head
    fr = g.first_record_day()
    out = [h, int(fr is not None), fr if fr is not None else 0]
    r = g.records.get(h - 1)
    if r is None:
        out.append(0)
    else:
        out += [1, r.value, STATUS[r.status], idx(ix, r.source), r.posted_at, r.final_at or 0, r.attested_at or 0,
                idx(ix, r.attested_by), int(r.changed), int(r.needs_sign), int(bool(r.dropped)), r.fresh, r.quorum,
                r.held, r.fresh_median, int(bool(r.late)), int(bool(r.incomplete)), int(r.carried)]
        if not r.carried:
            out += fields(ix, g, r.source, r.p, r.kinds, r.counts, g.states[h - 1], r.value)
    st = ix.pre_state(g, h)
    out += list(st.e) + list(st.miss) + [int(b) for b in st.inm] + [int(b) for b in st.was]
    return out


class V43(M.AgateIndex):
    def __init__(self, P, *a, **kw):
        super().__init__(P, *a, **kw)
        self._depth = 0
        self._trace = Trace(self)

    # ---- v4.3 contract semantics
    def eligible(self, g, d, w):
        return w is not None and self.active_writer(w) and (d, w) not in g.voided and (d, w) in g.acc

    def source_of(self, gpu, g, d, now):
        P = self.P
        fw = self.first_writer(g, d)
        if fw is not None and self.quorate(gpu, g, d, fw):
            return fw
        if now < P.day_end(d) + P.T_PEND:
            return None
        for w in self.writers:
            a = g.acc.get((d, w))
            if a is not None and a.bits == P.FULL_BITS and self.quorate(gpu, g, d, w):
                return w
        for w in self.writers:
            if self.quorate(gpu, g, d, w):
                return w
        return None

    def _close(self, gpu, caller, now):
        P = self.P
        g = self.gpus[gpu]
        d = g.head
        req(now >= P.day_end(d) + P.CLOSE_GRACE, "C1")
        prev = g.records.get(d - 1)
        req(prev is None or self.is_final(prev, now), "C2")
        w = self.source_of(gpu, g, d, now)
        req(w is not None, "C3")
        complete = g.acc[(d, w)].bits == P.FULL_BITS
        if now < P.day_end(d) + P.T_PEND and not complete:
            req(caller == w, "C4")
        req(self.active_writer(caller) or complete or now >= self.grace_start(g, d) + P.GRACE, "C4")
        rec, st, _ = self.build(gpu, g, d, w, now)
        rec.needs_sign = rec.changed or P.SIGN_ALL or w != self.first_writer(g, d)
        rec.final_at = None if rec.needs_sign else now + P.T_PEND
        g.records[d] = rec
        g.states[d] = st
        g.head = d + 1
        return rec

    def _attest(self, gpu, d, writer, digest, caller, now):
        P = self.P
        req(caller is not None and (caller == self.attester or self.is_guardian(caller)), "role")
        g = self.gpus[gpu]
        r = g.records.get(d)
        req(r is not None and d == g.head - 1, "NoPendingRecord")
        req(not self.is_final(r, now), "AlreadyFinal")
        req(r.attested_at is None, "AlreadyAttested")
        if writer is not None and writer != r.source:
            req(self.eligible(g, d, writer), "SelectNotEligible")
            if caller == self.attester:
                req(g.acc[(d, writer)].bits == P.FULL_BITS, "SelectIncomplete")
            rec, st, q = self.build(gpu, g, d, writer, r.posted_at)
            req(q >= P.Q_MIN, "SelectBelowQuorum")
            req(rec.digest == digest, "DigestMismatch")
            rec.needs_sign = rec.changed or P.SIGN_ALL or writer != self.first_writer(g, d)
            rec.attested_at = now
            rec.attested_by = caller
            rec.final_at = max(rec.posted_at + P.T_PEND, now)
            g.records[d] = rec
            g.states[d] = st
            self.attest_log.append((gpu, d, rec.digest, caller, now, r.source))
        else:
            req(r.digest == digest, "DigestMismatch")
            r.attested_at = now
            r.attested_by = caller
            if r.needs_sign:
                r.final_at = max(r.posted_at + P.T_PEND, now)
            self.attest_log.append((gpu, d, r.digest, caller, now, None))

    def _veto(self, gpu, d, caller, now):
        req(self.is_guardian(caller), "NotGuardian")
        g = self.gpus[gpu]
        r = g.records.get(d)
        req(r is not None and d == g.head - 1, "NoPendingRecord")
        req(not self.is_final(r, now), "AlreadyFinal")
        del g.records[d]
        g.states.pop(d, None)
        g.voided.add((d, r.source))
        g.reopened_at[d] = now
        g.head = d

    def carry_post(self, g, d):
        H = self.P.HOLD_DAYS
        st = self.pre_state(g, d)
        E = [w for w in self.writers if self.eligible(g, d, w)]
        if E:
            for i in range(g.n):
                if self.readable(g, i, d) and st.miss[i] < H:
                    if all(g.acc[(d, w)].cnt[i] < self.P.MIN_READINGS for w in E):
                        st.miss[i] += 1
        return st

    def _carry(self, gpu, caller, now):
        P = self.P
        g = self.gpus[gpu]
        r = g.records.get(g.head - 1)
        dropped = False
        if r is not None and not self.is_final(r, now):
            d = g.head - 1
            req(r.needs_sign and r.attested_at is None and r.final_at is None, "Carry1_NotDroppable")
            req(now >= max(self.grace_start(g, d) + P.HOLD_MOVE, r.posted_at + P.HOLD_MIN, g.last_carry_at + P.STEP),
                "Carry1_TooEarly")
            del g.records[d]
            g.states.pop(d, None)
            g.head = d
            dropped = True
            case = 1
        else:
            d = g.head
            req(now >= P.day_end(d), "Carry2_DayNotOver")
            prev = g.records.get(d - 1)
            req(prev is None or self.is_final(prev, now), "Carry2_PreviousNotFinal")
            t_req = max(self.grace_start(g, d) + P.GRACE, g.last_carry_at + P.STEP)
            if d in g.reopened_at:
                t_req = max(t_req, g.reopened_at[d] + P.REOPEN_WAIT)
            req(now >= t_req, "Carry2_TooEarly")
            for w in self.writers:
                req(not self.quorate(gpu, g, d, w), "Carry2_HasQuorum")
            case = 2
        prev = g.records.get(d - 1)
        g.head = d + 1
        g.last_carry_at = now
        if prev is not None:
            st = self.carry_post(g, d)
            g.records[d] = M.Record(day=d, value=prev.value, status=CARRIED, fresh=0, quorum=0, late=False,
                                    incomplete=False, changed=False, memb_changed=False, source=None, posted_at=now,
                                    final_at=now, attested_at=None, attested_by=None, digest=None, p=[0] * g.n,
                                    kinds=[OUT] * g.n, counts=[0] * g.n, held=0, fresh_median=0, carried=True,
                                    dropped=dropped, needs_sign=False)
            g.states[d] = st
        else:
            g.states.pop(d, None)
        try:
            self._close(gpu, caller, now)
        except Revert:
            pass
        return case

    # ---- the recorder (only top-level calls are recorded)
    def _rec(self, fn, op_head, after, *a):
        self._depth += 1
        top = self._depth == 1
        try:
            res = fn(*a)
            ok = True
        except Revert:
            res, ok = None, False
            if top:
                self._trace.ops.append(op_head + [0] + after(False, None))
            raise
        finally:
            self._depth -= 1
        if top:
            self._trace.ops.append(op_head + [1] + after(True, res))
        return res

    def close_day(self, gpu, caller, now):
        return self._rec(self._close, [2, now, idx(self, caller)],
                         lambda ok, r: snapshot(self) if ok else [], gpu, caller, now)

    def carry_day(self, gpu, caller, now):
        return self._rec(self._carry, [3, now, idx(self, caller)],
                         lambda ok, c: ([c] + snapshot(self)) if ok else [0], gpu, caller, now)

    def attest(self, gpu, d, writer, digest, caller, now):
        g = self.gpus[gpu]
        r = g.records.get(d)
        args = []
        w = writer
        if r is not None and (writer is None or writer == r.source):
            w = r.source
            if r.digest == digest and not r.carried:
                args = [1] + fields(self, g, r.source, r.p, r.kinds, r.counts, g.states[d], r.value)
        elif r is not None and writer is not None and self.eligible(g, d, writer):
            rec, st, _ = self.build(gpu, g, d, writer, r.posted_at)
            if rec.digest == digest:
                args = [1] + fields(self, g, writer, rec.p, rec.kinds, rec.counts, st, rec.value)
        if not args:
            args = [0]
        head = [4, now, idx(self, caller)]
        return self._rec(self._attest, head, lambda ok, _: [d, idx(self, w)] + args + (snapshot(self) if ok else []),
                         gpu, d, writer, digest, caller, now)

    def veto(self, gpu, d, caller, now):
        g = self.gpus[gpu]
        r = g.records.get(d)
        args = [0]
        if r is not None and not r.carried:
            args = [1] + fields(self, g, r.source, r.p, r.kinds, r.counts, g.states[d], r.value)
        return self._rec(self._veto, [5, now, idx(self, caller)],
                         lambda ok, _: [d] + args + (snapshot(self) if ok else []), gpu, d, caller, now)

    def suspend(self, writer, caller, now):
        return self._rec(super().suspend, [6, now, idx(self, caller)], lambda ok, _: [idx(self, writer)],
                         writer, caller, now)

    def register_gpu(self, caller, gpu, n, family, famq, first_day, live_at_start, now, recipe_hash="0xrecipe"):
        self._trace.n = n
        fams = sorted(famq)
        mask = sum(1 << i for i in range(n) if live_at_start[i])
        rest = [n, len(fams)] + list(family) + [famq[f] for f in fams] + [first_day, mask]
        return self._rec(super().register_gpu, [7, now, idx(self, caller)], lambda ok, _: rest,
                         caller, gpu, n, family, famq, first_day, live_at_start, now, recipe_hash)

    def _item(self, item):
        k = item[0]
        if k in ("writer", "guardian"):
            return [0 if k == "writer" else 2, item[1], idx(self, item[2]), 0]
        if k == "attester":
            return [1, 0, idx(self, item[1]), 0]
        if k in ("live_from", "live_until"):
            return [4 if k == "live_from" else 5, item[2], 7, item[3]]
        raise ValueError(k)

    def queue(self, caller, item, now):
        return self._rec(super().queue, [8, now, idx(self, caller)], lambda ok, _: self._item(item), caller, item,
                         now)

    def execute(self, caller, item, now):
        return self._rec(super().execute, [9, now, idx(self, caller)], lambda ok, _: self._item(item), caller,
                         item, now)

    def on_report(self, msg_sender, tx_origin, now, report):
        version, chain, index_addr, entries = report
        flags = (1 if version != 1 else 0) | (2 if chain != M.CHAIN else 0) | (4 if index_addr != self.address else 0)
        ents = []
        days = []
        for (gpu, day, sl, ra, vals) in entries:
            known = int(gpu == GPU)
            ents += [known, day, sl, ra, len(vals)] + list(vals)
            if known and day not in days:
                days.append(day)
        head = [1, now, idx(self, tx_origin)]

        def after(ok, _):
            out = [flags, len(entries)] + ents
            if not ok or tx_origin not in ("w1", "w2") or GPU not in self.gpus:
                return out + [0]
            g = self.gpus[GPU]
            accs = []
            for d in days:
                a = g.acc.get((d, tx_origin))
                if a is None:
                    accs += [d, 0] + [0] * (2 * g.n)
                else:
                    accs += [d, a.bits] + list(a.sum) + list(a.cnt)
            return out + [len(days)] + accs

        return self._rec(super().on_report, head, after, msg_sender, tx_origin, now, report)


M.AgateIndex = V43


# ---------------------------------------------------------------------------------------------- random worlds

def header(ix, signAll=False, demo=False):
    P = ix.P
    return [P.DAY, P.SLICES, P.MIN_READINGS, P.Q_MIN, int(demo or P.Q_MIN < 3), int(signAll), P.EPOCH_TS, P.EPOCH_DAY,
            len([w for w in ix.writers if w]), len([x for x in ix.guardians if x])]


def world(seed, profile, signAll=False, days=8, families=None):
    rng = random.Random(seed)
    oct1 = M.dn(2026, 10, 1)
    first = oct1 + rng.randrange(0, 25)
    epoch_day = first - 1
    Q_MIN = profile.get("Q_MIN", 3)
    P = M.Params(DAY=profile["DAY"], SLICES=profile["SLICES"], MIN_READINGS=profile["MIN_READINGS"], Q_MIN=Q_MIN,
                 EPOCH_TS=1_000_000, EPOCH_DAY=epoch_day, signAll=signAll)
    ix = M.AgateIndex(P, writers=("w1", "w2"), attester="att", guardians=("g1",))
    n = rng.randint(4, 7)
    if families and rng.random() < 0.5:
        family = [0, 0] + list(range(1, n - 1))
        famq = {f: 1 for f in set(family)}
        if rng.random() < 0.5:
            famq[0] = 2
    else:
        family = list(range(n))
        famq = {f: 1 for f in family}
    live = [True] * n
    if rng.random() < 0.3:
        live[n - 1] = False
    t0 = P.day_start(first)
    ix.register_gpu("owner", GPU, n, family, famq, first, live, t0 - 10)
    base = [rng.randrange(300, 420) * M.TICK for _ in range(n)]
    dark = {(rng.randrange(n), first + rng.randrange(days)) for _ in range(rng.randint(0, 3))}
    t = t0
    end = P.day_start(first + days)
    queued_until = False
    while t < end + 3 * P.DAY:
        t += max(1, P.SLICE // 2 + rng.randrange(-P.SLICE // 4, P.SLICE // 4 + 1))
        d = P.day_of(t)
        h = (t - P.day_start(d)) // P.SLICE
        act = rng.random()
        try:
            if act < 0.5 and d < first + days:
                w = rng.choice(["w1", "w1", "w2", "w2", "w1"])
                if rng.random() < 0.04:
                    i = rng.randrange(n)
                    base[i] = cent(base[i] * rng.choice([90, 110, 116]) // 100)
                vals = [0 if (i, d) in dark or rng.random() < 0.07 else b for i, b in enumerate(base)]
                if w == "w2" and rng.random() < 0.3:
                    vals = [cent(v * 21 // 20) if v else 0 for v in vals]
                if rng.random() < 0.03:
                    vals[rng.randrange(n)] = 3_000_001  # off the cent grid
                if rng.random() < 0.15:
                    # a report with several slices of the day so far (a catch-up repost)
                    hs = sorted({rng.randrange(h + 1) for _ in range(rng.randint(1, 4))})
                    ents = [(GPU, d, hh, min(t, P.slice_start(d, hh) + rng.randrange(P.SLICE)), vals) for hh in hs]
                else:
                    dd = d - 1 if (rng.random() < 0.08 and d > first) else d
                    hh = rng.randrange(P.SLICES) if dd != d else h
                    ra = P.slice_start(dd, hh) + rng.randrange(P.SLICE)
                    if ra > t:
                        ra = t
                    ents = [(GPU, dd, hh, ra, vals)]
                ix.on_report(ix.forwarder, w, t, (1, M.CHAIN, ix.address, ents))
            elif act < 0.68:
                ix.close_day(GPU, rng.choice(["w1", "w2", "keeper"]), t)
            elif act < 0.78:
                ix.carry_day(GPU, "keeper", t)
            elif act < 0.94:
                g = ix.gpus[GPU]
                dd = g.head - 1
                r = g.records.get(dd)
                if r is None:
                    continue
                who = rng.choice(["att", "att", "g1"])
                writer = rng.choice([None, None, "w1", "w2"])
                if writer is None or writer == r.source:
                    dg = r.digest if rng.random() < 0.9 else "wrong"
                    ix.attest(GPU, dd, r.source, dg, who, t)
                else:
                    if ix.eligible(g, dd, writer):
                        dg = ix.build(GPU, g, dd, writer, r.posted_at)[0].digest
                    else:
                        dg = "none"
                    if rng.random() < 0.1:
                        dg = "wrong"
                    ix.attest(GPU, dd, writer, dg, who, t)
            elif act < 0.98:
                g = ix.gpus[GPU]
                ix.veto(GPU, g.head - 1, "g1", t)
            elif act < 0.985:
                ix.suspend("w2", "g1", t)
            elif act < 0.99 and not queued_until and live[0]:
                g = ix.gpus[GPU]
                dd = P.day_of(t + P.TIMELOCK) + 1
                ix.queue("owner", ("live_until", GPU, 0, dd), t)
                queued_until = (("live_until", GPU, 0, dd), t + P.TIMELOCK)
            elif queued_until and queued_until is not True and t >= queued_until[1]:
                item = queued_until[0]
                queued_until = True
                ix.execute("owner", item, t)
            elif "w2" in ix.suspended and ("writer", 1, "w2") not in ix.queued and rng.random() < 0.5:
                ix.queue("owner", ("writer", 1, "w2"), t)
        except Revert:
            pass
        # an appointment queued above is executed after the timelock
        for item, eta in list(ix.queued.items()):
            if item[0] == "writer" and t >= eta:
                try:
                    ix.execute("owner", item, t)
                except Revert:
                    pass
    return header(ix, signAll=signAll, demo=Q_MIN < 3)


# ---------------------------------------------------------------------------------------------- scenario worlds

def worked_example():
    """The brief's worked example, index side: 7 single-cloud families at BASE, the step to AFTER on Nov 11 (3.60 to
    4.20), one writer, the attester (rule R as modelled) and the keeper, production clock, Nov 1 to Nov 15."""
    nov1, nov11 = M.dn(2026, 11, 1), M.dn(2026, 11, 11)
    P = M.Params(**M.PRODUCTION)
    ix = M.AgateIndex(P, writers=("w1",), attester="att", guardians=("g1",))
    ix.register_gpu("owner", GPU, 7, list(range(7)), {f: 1 for f in range(7)}, nov1, [True] * 7,
                    P.day_start(nov1) - 10)
    price = lambda d: M.AFTER if d >= nov11 else M.BASE  # noqa: E731
    pages = M.FnPages(P, lambda i, t: price(P.day_of(t))[i], 7)
    watcher = M.Watcher(P, pages, P.day_start(nov1) - P.SLICE)
    att = M.Attester("att", watcher, GPU)
    hw = M.HonestWriter("w1", pages, random.Random(1))
    sim = M.Sim(ix, GPU, [hw], attester=att, writer_offset=lambda wr, d, h: P.SLICE * 10 // 60)
    sim.run(P.day_start(nov1), P.day_start(nov1 + 15))
    return header(ix)


def scenario_traces():
    hs = []
    hs.append(("worked example Nov 1-15 (3.60 -> 4.20 on Nov 11)", worked_example()))
    n0 = len(TRACES)
    M.plant_scenario(standby=True, per_slot=True, delay=None)  # two worlds: honest, then the B1 thief (S7)
    M.plant_scenario(standby=False, per_slot=True, delay=3600)
    for k, tr in enumerate(TRACES[n0:]):
        hs.append((f"B1 world S7 #{k}", header(tr.ix)))
    n0 = len(TRACES)
    M.freeze_scenario(standby=True)
    M.freeze_scenario(standby=False)
    for k, tr in enumerate(TRACES[n0:]):
        hs.append((f"freeze #{k}", header(tr.ix)))
    return hs


def main():
    out_dir = HERE
    names = []
    # scenario worlds first (their TRACES entries are taken in creation order)
    scen = scenario_traces()
    names += [s[0] for s in scen]
    heads = [s[1] for s in scen]
    TEST = dict(DAY=2_400, SLICES=12, MIN_READINGS=6)
    DEMO = dict(DAY=600, SLICES=4, MIN_READINGS=2, Q_MIN=1)
    PROD = dict(DAY=86_400, SLICES=24, MIN_READINGS=12)
    seed = 4_300
    for k in range(70):
        heads.append(world(seed + k, TEST, families=True))
        names.append(f"random TEST #{k}")
    for k in range(12):
        heads.append(world(seed + 100 + k, TEST, signAll=True, families=True))
        names.append(f"random TEST signAll #{k}")
    for k in range(12):
        heads.append(world(seed + 200 + k, DEMO, days=10))
        names.append(f"random DEMO #{k}")
    for k in range(4):
        heads.append(world(seed + 300 + k, PROD, days=4))
        names.append(f"random PRODUCTION #{k}")
    assert len(heads) == len(TRACES), (len(heads), len(TRACES))
    for f in os.listdir(out_dir):
        if f.startswith("diff_") and f.endswith(".json"):
            os.remove(os.path.join(out_dir, f))
    per = 10
    total_ops = 0
    files = 0
    for start in range(0, len(TRACES), per):
        batch = []
        for k in range(start, min(start + per, len(TRACES))):
            tr = TRACES[k]
            ops = [x for op in tr.ops for x in op]
            total_ops += len(tr.ops)
            batch.append({"header": heads[k] + [tr.mode], "ops": ops, "nOps": len(tr.ops)})
        with open(os.path.join(out_dir, f"diff_{files:03d}.json"), "w") as fh:
            json.dump({"count": len(batch), "traces": batch}, fh, separators=(",", ":"))
        files += 1
    with open(os.path.join(out_dir, "diff_index.json"), "w") as fh:
        json.dump({"files": files, "traces": len(TRACES)}, fh)
    for k, nm in enumerate(names):
        print(f"trace {k:3d} (file {k // per}, #{k % per}): {nm}, {len(TRACES[k].ops)} calls")
    print(f"{len(TRACES)} traces, {total_ops} calls, {files} files")


if __name__ == "__main__":
    main()
