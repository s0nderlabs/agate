// The market fork run's report: named checks (each tied to a BOTS-SPEC 6 scenario), measured numbers and the gas
// table of every shape the bots sent (E16).
export interface Check {
  id: string; // E1 .. E20, or a brief step
  name: string;
  ok: boolean;
  detail: string;
}

export interface GasRow {
  bot: string;
  shape: string;
  detail: string;
  gasLimit: string;
  gasUsed: string;
  tx: string;
}

export class Report {
  checks: Check[] = [];
  numbers: Record<string, unknown> = {};
  gas: GasRow[] = [];
  steps: { at: string; what: string; ms: number }[] = [];
  private t0 = Date.now();
  constructor(private readonly say: (s: string) => void = (s) => console.log(s)) {}

  check(id: string, name: string, ok: boolean, detail: unknown = ""): boolean {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    this.checks.push({ id, name, ok, detail: d });
    this.say(`${ok ? "PASS" : "FAIL"} ${id} ${name}${d ? `: ${d.length > 400 ? `${d.slice(0, 400)}...` : d}` : ""}`);
    return ok;
  }
  num(name: string, v: unknown): void {
    this.numbers[name] = typeof v === "bigint" ? v.toString() : v;
  }
  step(what: string): void {
    const ms = Date.now() - this.t0;
    this.steps.push({ at: new Date().toISOString(), what, ms });
    this.say(`== [${(ms / 1000).toFixed(1)} s] ${what}`);
  }
  get ok(): boolean {
    return this.checks.length > 0 && this.checks.every((c) => c.ok);
  }
  failed(): Check[] {
    return this.checks.filter((c) => !c.ok);
  }
  json(): string {
    return JSON.stringify({ ok: this.ok, checks: this.checks, numbers: this.numbers, gas: this.gas, steps: this.steps }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1);
  }
}
