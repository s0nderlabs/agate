"use client";
// The docs' first chapter, How Agate works: a chapter like the others (its headline and lede, its sections, On this
// page on the right, the next chapter at the foot) whose six steps are each one plain headline, a line or two, and one
// picture drawn on the live H100 month (components/explain/figures). The one picture you can play with is Long or
// Short. The steps' names and words live in lib/docs/explainer, so the chapter list and the search read the same.
import Link from "next/link";
import { BackedFigure, CloseFigure, CloudsFigure, DailyFigure, MonthFigure, PayoffFigure } from "@/components/explain/figures";
import { useWorked } from "@/components/how/worked";
import { HOW_STEPS, HOW_TITLE } from "@/lib/docs/explainer";
import { usd } from "@/lib/format";
import { useLinkQuery } from "@/lib/mock/store";
import { useSay } from "@/lib/ui/useSay";
import { onHeadingLink } from "./anchorCopy";
import { docHref } from "./ChapterList";
import { Pager, Toc, useReading, type Near } from "./DocArticle";
import s from "./docs.module.css";
import p from "./prose.module.css";

/** A step's head, with its # like every heading in the docs. */
function Head({ n }: { n: number }) {
  const step = HOW_STEPS[n];
  return (
    <h2 id={step.id}>
      {step.text}
      <a className="anchor" href={`#${step.id}`} aria-label={`Link to ${step.text}`} />
    </h2>
  );
}

/** A line under a picture that leads to the chapter with the whole story. */
function More({ slug, children }: { slug: string; children: React.ReactNode }) {
  const q = useLinkQuery();
  return (
    <p>
      <Link href={docHref(slug, null, q)}>{children}</Link>
    </p>
  );
}

export function HowChapter({ next }: { next: Near }) {
  const w = useWorked();
  const q = useLinkQuery();
  const active = useReading(HOW_STEPS.map((x) => x.id));
  const [said, say] = useSay();
  return (
    <main className={s.doc}>
      <article className={s.article}>
        <header className={s.head}>
          <div className={s.headRow}>
            <div className={`${s.prose} ${p.prose} ${s.title}`}>
              <h1>{HOW_TITLE}</h1>
            </div>
          </div>
        </header>
        <div className={`${s.prose} ${p.prose} ${s.body}`} onClick={(e) => onHeadingLink(e, say)}>
          <p>
            Agate lets you trade the price of renting a GPU, one month at a time. Six short steps, each on the real H100 market{w.live ? "" : " as of Oct 8"}.
          </p>

          <Head n={0} />
          <p>{HOW_STEPS[0].words}</p>
          <CloudsFigure />
          <More slug="the-price">How the price is made</More>

          <Head n={1} />
          <p>{HOW_STEPS[1].words}</p>
          <MonthFigure />
          <More slug="the-market">The monthly market</More>

          <Head n={2} />
          <p>
            Long gains if {w.month} averages above today&rsquo;s price, Short if it averages below. Renting GPUs? Long locks in your cost. Renting them out? Short locks in your
            income.
          </p>
          <PayoffFigure />

          <Head n={3} />
          <p>
            The average only counts between {usd(w.floor)} and {usd(w.cap)}, so every trade is paid in full when it opens. Nothing is borrowed.
          </p>
          <BackedFigure />

          <Head n={4} />
          <p>{HOW_STEPS[4].words}</p>
          <DailyFigure />

          <Head n={5} />
          <p>{HOW_STEPS[5].words}</p>
          <CloseFigure />
          <p>
            Everything here uses free test dollars on Monad&rsquo;s test network: 10,000 a day, no wallet needed. <Link href={`/app${q}`}>Trade H100 {w.month}</Link>, or try
            it step by step in the <Link href={docHref("quickstart", null, q)}>Quickstart</Link>.
          </p>
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {said}
        </span>
        {next && (
          <footer className={s.foot}>
            <Pager prev={null} next={next} q={q} />
          </footer>
        )}
      </article>
      <Toc items={HOW_STEPS.map((x) => ({ id: x.id, text: x.text, depth: 2 }))} active={active} />
    </main>
  );
}
