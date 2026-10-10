"use client";
// The landing page, being judged one section at a time (the Oct 8 rule: each section is one piece of the product,
// rebuilt big, never a screenshot of the app). The hero: after the pick of 6 and 9, two animated silicon heroes
// (the wafer, the chip) beside 6 and 9; then what an hour of compute is, from one multiply up. Flipped from Mock controls (its arrows, the list) or the number keys and the arrow keys.
import { useEffect, useState, type ComponentType } from "react";
import { stillMode } from "@/components/lab/data";
import type { Landing } from "@/lib/mock/config";
import { useMock } from "@/lib/mock/store";
import { FoldLoader } from "./FoldLoader";
import { Site } from "./site/Site";
import { Story } from "./story/Story";
import { useLandingKeys } from "./kit";
import { H06Line } from "./hero/H06Line";
import { H09Hours } from "./hero/H09Hours";
import { H11Chip } from "./hero/H11Chip";
import { H12Wafer } from "./hero/H12Wafer";
import { H15Hour, H15HourLight, H15HourLow } from "./hero/H15Hour";
import { H23Open } from "./hero/H23Open";
import { H24Chips, H24ChipsField, H24ChipsHorizon, H24ChipsLand, H24ChipsMono, H24ChipsSheet } from "./hero/H24Chips";
import { H16Answer } from "./hero/H16Answer";
import { H17Dial } from "./hero/H17Dial";
import { H18Clean } from "./hero/H18Clean";
import { H19Bands } from "./hero/H19Bands";
import { H20Plot } from "./hero/H20Plot";
import { H21Loom } from "./hero/H21Loom";
import { H22Signals } from "./hero/H22Signals";

const PAGES: Record<Landing, ComponentType> = {
  chipsfield: H24ChipsField,
  chipsheet: H24ChipsSheet,
  chipsland: H24ChipsLand,
  chipshorizon: H24ChipsHorizon,
  chips: H24Chips,
  chipsmono: H24ChipsMono,
  open: H23Open,
  hour: H15Hour,
  hourlow: H15HourLow,
  hourlight: H15HourLight,
  clean: H18Clean,
  bands: H19Bands,
  loom: H21Loom,
  plot: H20Plot,
  signals: H22Signals,
  answer: H16Answer,
  dial: H17Dial,
  wafer: H12Wafer,
  chip: H11Chip,
  hours: H09Hours,
  line: H06Line,
};

export function LandingScreen() {
  const { config } = useMock();
  const [still, setStill] = useState(false);
  useLandingKeys();
  const Page = PAGES[config.landing];
  useEffect(() => {
    document.title = "Agate · The price of compute, made tradable";
    setStill(stillMode());
  }, []);
  return (
    <div data-landing={config.landing} data-still={still ? "" : undefined}>
      {/* (only the chips heroes wait for it; the others would play their opening under it) */}
      {config.intro === "fold" && config.landing.startsWith("chips") && <FoldLoader tone={config.theme} />}
      {/* (below the chips heroes: the Oct 10 site, the chip dive then a market page; or the Oct 9 story told in zooms,
          the hero its first scene, the camera diving into it) */}
      {config.story === "site" && config.landing.startsWith("chips") ? (
        <Site key={config.turnAt} turnAt={config.turnAt} hero={<Page key={config.landing} />} />
      ) : config.story === "on" && config.landing.startsWith("chips") ? (
        <Story hero={<Page key={config.landing} />} />
      ) : (
        <Page key={config.landing} />
      )}
    </div>
  );
}
