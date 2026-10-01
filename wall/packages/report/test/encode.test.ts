import { expect, test } from "bun:test";
import { join } from "node:path";
import { decodeReport, encodeReport } from "../src/encode.ts";
import { example } from "../scripts/gen-example.ts";

test("report round-trips and matches the committed vector", async () => {
  const x = example();
  const hex = encodeReport(x.report);
  expect(decodeReport(hex)).toEqual(x.report);
  const vec = await Bun.file(join(import.meta.dir, "../../../../contracts/test/vectors/report_example.json")).json();
  expect(vec.reportHex).toBe(hex);
  expect(vec.digest).toBe(x.digest);
});
