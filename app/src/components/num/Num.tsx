// Even-width digits. Neither Erode nor Apfel Grotezk ships tabular figures, so each digit gets the same
// box; columns line up and live numbers do not jitter, while the brand fonts stay. Screen readers get the
// whole number once from the hidden copy, since aria-label on a plain span is ignored.
export function Num({ children, className }: { children: string; className?: string }) {
  return (
    <span className={`ag-num ${className ?? ""}`}>
      <span className="sr-only">{children}</span>
      <span aria-hidden="true">
        {Array.from(children).map((ch, i) =>
          ch >= "0" && ch <= "9" ? (
            <span key={i} className="ag-num__d">
              {ch}
            </span>
          ) : (
            <span key={i}>{ch}</span>
          ),
        )}
      </span>
    </span>
  );
}
