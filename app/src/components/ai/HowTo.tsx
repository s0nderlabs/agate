"use client";
// How to let an AI trade (wallet spec 10.2): pick the AI app, then add Agate's link where that app takes it; an app
// that signs in by itself (OAuth) then asks for the person's OK on the Allow page, the others are connected from here
// first and take the link made for them. Used as the empty Connected AIs page, its side column and the "Add another
// AI" sheet. The apps, their marks and their steps live in apps.tsx.
import Link from "next/link";
import { useState } from "react";
import { useAiBackend, useMcpUrl } from "@/lib/account/ai";
import { AGATE_SERVER } from "@/lib/account/realAi";
import { useLinkQuery } from "@/lib/mock/store";
import { CopyButton } from "@/components/flow/Copy";
import { AI_APPS, AppMark, type AiApp, type AppId } from "./apps";

/** Where an app connects from inside Agate: Connect, with the app's name already picked. */
export function connectHref(app: AiApp | null, q: string) {
  const more = q.replace(/^\?/, "");
  return `/app/connect${app ? `?app=${app.id}${more ? `&${more}` : ""}` : q}`;
}

/** The apps as a row of tiles, each with its mark; one is picked (null: none, or `other` when it is on). `other` adds
 *  a last "Other" tile for any other AI app (Connect). */
export function AppPicker(p: { picked: AppId | null; onPick: (a: AiApp) => void; label?: string; labelledBy?: string; disabled?: boolean; other?: { on: boolean; onPick: () => void } }) {
  return (
    <div className="ag-apps" role="radiogroup" aria-label={p.labelledBy ? undefined : (p.label ?? "Your AI app")} aria-labelledby={p.labelledBy}>
      {AI_APPS.map((a) => (
        <button key={a.id} type="button" role="radio" aria-checked={!p.other?.on && p.picked === a.id} className="ag-app" disabled={p.disabled} onClick={() => p.onPick(a)}>
          <AppMark app={a} size={28} />
          <span>{a.name}</span>
        </button>
      ))}
      {p.other && (
        <button type="button" role="radio" aria-checked={p.other.on} className="ag-app" disabled={p.disabled} onClick={p.other.onPick}>
          <AppMark app={null} size={28} />
          <span>Other</span>
        </button>
      )}
    </div>
  );
}

/** A line to paste or run, shown whole (it wraps), selectable, with its Copy button. */
export function CodeLine({ text, what, label }: { text: string; what: string; label: string }) {
  return (
    <div className="grid gap-2">
      <pre className="ag-codeline" tabIndex={0} aria-label={label}>
        {text}
      </pre>
      <span>
        <CopyButton text={text} what={what} />
      </span>
    </div>
  );
}

export function HowTo({ heading = "h2", onGo, intro = true }: { heading?: "h1" | "h2"; onGo?: () => void; intro?: boolean }) {
  const [id, setId] = useState<AppId>("claude");
  const app = AI_APPS.find((a) => a.id === id)!;
  const mcp = useMcpUrl();
  const { backend } = useAiBackend();
  const q = useLinkQuery();
  const url = mcp.data ?? "";
  // live reads the real server's public link, signed in or not; a build with no server (or a link that is not https,
  // or one that cannot be read) never offers a link to paste into a real AI app
  const notPublic = (!!url && !url.startsWith("https://")) || (!backend.example && (!AGATE_SERVER || mcp.isError));
  const H = heading;
  const text = app.line ? app.line(url) : url;
  return (
    <div className="grid gap-[18px]">
      {intro && (
        <div className="grid gap-2">
          <H>Let your AI trade on Agate</H>
          <p>Pick your AI app. It trades only from a pocket you fund, inside limits you set, and you can stop it at any time.</p>
        </div>
      )}
      <AppPicker picked={id} onPick={(a) => setId(a.id)} />
      <div className="grid gap-3" aria-live="polite">
        {app.oauth ? (
          <>
            <p>{app.paste}</p>
            {notPublic ? (
              <p className="ag-fine">Agate's AI link isn't public on this build yet.</p>
            ) : mcp.isPending ? (
              <span className="ag-codeline ag-skel ag-skel-on" aria-hidden="true">
                https://
              </span>
            ) : (
              <CodeLine text={text} what={app.line ? "the line" : "the link"} label={app.line ? `The line for ${app.name}` : "Agate's link for AI apps"} />
            )}
            {app.then && <p>{app.then}</p>}
          </>
        ) : (
          <>
            <p>
              {app.name} can't sign in to Agate by itself yet, so connect it from here: you set its pocket, and Agate gives you a link made for {app.name} to add.
            </p>
            <Link className="ag-btn ag-btn--primary" style={{ justifySelf: "start" }} href={connectHref(app, q)} onClick={onGo}>
              Connect {app.name} from here
            </Link>
          </>
        )}
        {!app.tried && <p className="ag-fine">Agate hasn't tried {app.name} itself yet. If it can't sign in, connect it from here and add the link Agate gives you.</p>}
      </div>
      {app.oauth && (
        <p>
          <Link className="ag-textbtn" href={connectHref(app, q)} onClick={onGo}>
            Connect from here instead
          </Link>
        </p>
      )}
    </div>
  );
}
