// "How Agate works": the docs' one chapter written in the app rather than in docs/site, because each of its steps is a
// picture drawn on the live market (components/docs/HowChapter). Listed first under Get started; its steps are its
// sections for the chapter list, On this page and the search.
import type { ChapterSource } from "./search";
import type { NavChapter } from "./types";

export const HOW_SLUG = "how-agate-works";
export const HOW_TITLE = "How Agate works";
export const HOW_DESCRIPTION = "Six short steps, each with a picture on the real H100 market: the price, a month, Long or Short, what you can lose, daily pay and closing.";

/** The steps, each one section: its anchor, its heading and the words a search reads for it. */
export const HOW_STEPS = [
  { id: "one-price-for-a-gpu-hour", text: "1. One price for a GPU hour", words: "Clouds rent out the same Nvidia H100 at different prices. Agate takes the middle one each day, so no single cloud can move it." },
  { id: "trade-a-whole-month", text: "2. Trade a whole month", words: "Each month has its own market. It pays that month's average price: every day's price, added up and divided by the days." },
  { id: "pick-a-side", text: "3. Pick a side", words: "Long gains if the month averages above today's price, Short if it averages below. Renting GPUs? Long locks in your cost. Renting them out? Short locks in your income." },
  { id: "you-cant-lose-more-than-you-put-in", text: "4. You can't lose more than you put in", words: "The average only counts between the month's lowest and highest, so every trade is paid in full when it opens. Nothing is borrowed." },
  { id: "get-paid-every-day-if-you-like", text: "5. Get paid every day, if you like", words: "Turn on Pay me daily and each day pays its share once that day's price is set. Over the month it comes to the same as waiting." },
  { id: "close-any-time", text: "6. Close any time", words: "Before the month ends, close at the going price and keep the difference." },
] as const;

export const HOW_NAV: NavChapter = { slug: HOW_SLUG, title: HOW_TITLE, description: HOW_DESCRIPTION, sections: HOW_STEPS.map(({ id, text }) => ({ id, text })) };

export const HOW_LEDE = "Agate lets you trade the price of renting a GPU, one month at a time. Six short steps, each on the real H100 market.";

/** The chapter as the search reads it: the lede, then each step with its words. */
export const HOW_SOURCE: ChapterSource = {
  slug: HOW_SLUG,
  title: HOW_TITLE,
  description: HOW_DESCRIPTION,
  toc: HOW_STEPS.map(({ id, text }) => ({ id, text, depth: 2 as const })),
  sections: [{ id: null, heading: HOW_TITLE, text: HOW_LEDE }, ...HOW_STEPS.map(({ id, text, words }) => ({ id, heading: text, text: words }))],
};
