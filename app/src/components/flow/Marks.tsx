// The marks the sign-in sheet and the account button show: Google's own "G" (its sign-in branding asks for the
// original four colours, unaltered, on a light or neutral button), a passkey, and the person's avatar: the first
// letter of their email on a tone drawn from it, so each account looks like its own.

/** Google's "G", in its own colours (from Google's sign-in branding files). */
export function GoogleG({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** A passkey: a key with a person's silhouette, the shape browsers and password managers use for one. In the text's own colour. */
export function PasskeyMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9.5" cy="7" r="4" />
      <path d="M2 21a7.5 7.5 0 0 1 11-6.6" />
      <circle cx="18" cy="13" r="2.5" />
      <path d="M18 15.5V22M18 19h2" />
    </svg>
  );
}

/** The tones an avatar may take: deep enough for a light letter in both themes, none of them up or down green or red. */
const TONES = ["#3d5a80", "#5b4a7a", "#7a4f3a", "#2f6a64", "#6b5d2f", "#4a5568", "#7a3f5c", "#355c4a"];

function toneOf(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
}

/** The letter an email's avatar shows: its first letter or digit in any script ("émile@" gives "É"), or null. */
export function avatarLetter(who?: string | null) {
  return (who ?? "").trim().match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() ?? null;
}

/** The person's avatar: the first letter of their email on a tone drawn from it; a plain mark while it has none. */
export function Avatar({ who, size = 34 }: { who?: string | null; size?: number }) {
  const seed = (who ?? "").trim().toLowerCase();
  const letter = avatarLetter(who);
  if (!letter) {
    return (
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round">
        <circle cx="12" cy="8.5" r="4" />
        <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
      </svg>
    );
  }
  return (
    <span aria-hidden="true" data-avatar="" style={{ background: toneOf(seed), width: size, height: size, fontSize: Math.round(size * 0.46) }}>
      {letter}
    </span>
  );
}
