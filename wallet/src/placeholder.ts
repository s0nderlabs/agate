// The placeholder address a passkey account carries: Dynamic holds every account to an email while email sign-in is
// on, so agate's server puts pk-<32 hex>@<domain> (one way from the account's sub, nobody's mailbox) in the sign-in
// JWT. Shared by the server (which mints it and hides it from /api/me) and the app (which never shows it).
export const placeholderAddress = (hex32: string, domain: string): string => `pk-${hex32}@${domain}`;
export const isPlaceholderEmail = (email: string): boolean => /^pk-[0-9a-f]{32}@/.test(email);

/** the address itself when it is a real email, else null (absent, not a string, or a placeholder) */
export const realEmail = (email: unknown): string | null => (typeof email === "string" && email && !isPlaceholderEmail(email) ? email : null);
