"use client";
// How to let an AI trade (wallet spec 10.2): add Agate's link to the AI app, which then asks for the person's OK on
// the Allow page. The link is the resource of the server's protected-resource metadata. Used as the empty Connected
// AIs page and as the "Add another AI" sheet. ChatGPT and Cursor join once their menu names are checked.
import Link from "next/link";
import { useState } from "react";
import { useAiBackend, useMcpUrl } from "@/lib/account/ai";
import { AGATE_SERVER } from "@/lib/account/realAi";
import { useLinkQuery } from "@/lib/mock/store";
import { CopyButton } from "@/components/flow/Copy";

type App = "claude" | "code";

export function HowTo({ heading = "h2", onGo }: { heading?: "h1" | "h2"; onGo?: () => void }) {
  const [app, setApp] = useState<App>("claude");
  const mcp = useMcpUrl();
  const { backend } = useAiBackend();
  const q = useLinkQuery();
  const url = mcp.data ?? "";
  // live reads the real server's public link, signed in or not; a build with no server (or a link that is not https,
  // or one that cannot be read) never offers a link to paste into a real AI app
  const notPublic = (!!url && !url.startsWith("https://")) || (!backend.example && (!AGATE_SERVER || mcp.isError));
  const H = heading;
  const command = `claude mcp add --transport http agate ${url}`;
  return (
    <div className="grid gap-[18px]">
      <H>Let your AI trade on Agate</H>
      <p>Add Agate to your AI app. It then asks for your OK here, and trades only from a pocket you fund.</p>
      <div className="ag-seg ag-seg--tall" role="group" aria-label="Your AI app" style={{ justifySelf: "start" }}>
        <button type="button" aria-pressed={app === "claude"} onClick={() => setApp("claude")}>
          Claude
        </button>
        <button type="button" aria-pressed={app === "code"} onClick={() => setApp("code")}>
          Claude Code
        </button>
      </div>
      {app === "claude" ? (
        <ol className="grid gap-1.5 pl-5" style={{ listStyle: "decimal" }}>
          <li>In Claude, open Settings, then Connectors.</li>
          <li>Choose Add custom connector and paste this link.</li>
          <li>Claude opens Agate to ask for your OK.</li>
        </ol>
      ) : (
        <p>Run this in your terminal. Claude Code then opens Agate to ask for your OK.</p>
      )}
      {notPublic ? (
        <p className="ag-fine">Agate's AI link isn't public on this build yet.</p>
      ) : (
        <div className="grid gap-2">
          <input className="ag-input" readOnly aria-label={app === "claude" ? "Agate's link for AI apps" : "Command for Claude Code"} value={mcp.isPending ? "" : app === "claude" ? url : command} onFocus={(e) => e.currentTarget.select()} />
          {url && (
            <span>
              <CopyButton text={app === "claude" ? url : command} what={app === "claude" ? "the link" : "the command"} />
            </span>
          )}
        </div>
      )}
      <p>
        <Link className="ag-textbtn" href={`/app/connect${q}`} onClick={onGo}>
          Connect from here instead
        </Link>
      </p>
    </div>
  );
}
