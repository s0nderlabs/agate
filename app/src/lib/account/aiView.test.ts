import { describe, expect, test } from "bun:test";
import { safeReturn } from "./aiView";

describe("safeReturn: an AI app's return address", () => {
  test("http(s) and an app's own scheme are opened", () => {
    expect(safeReturn("https://claude.ai/api/mcp/auth_callback?code=x")).toBe("https://claude.ai/api/mcp/auth_callback?code=x");
    expect(safeReturn("http://127.0.0.1:6274/callback?code=x")).toBe("http://127.0.0.1:6274/callback?code=x");
    expect(safeReturn("cursor://anysphere.cursor-retrieval/oauth/callback?code=x")).toBe("cursor://anysphere.cursor-retrieval/oauth/callback?code=x");
    expect(safeReturn("vscode://ms.vscode/callback?code=x")).toBe("vscode://ms.vscode/callback?code=x");
  });

  test("an address that would run script in the page or read local data is refused, however it is written", () => {
    for (const u of [
      "javascript:alert(document.cookie)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "javascript:alert(1)?code=x",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://agate.example/123",
      "about:blank",
    ]) {
      expect(safeReturn(u)).toBeNull();
    }
  });

  test("nothing, or an address that does not parse, is refused", () => {
    expect(safeReturn(undefined)).toBeNull();
    expect(safeReturn("")).toBeNull();
    expect(safeReturn("not a url")).toBeNull();
  });
});
