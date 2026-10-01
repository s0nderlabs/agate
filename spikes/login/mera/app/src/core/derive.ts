// PRF output -> BIP-39 mnemonic -> seed -> m/44'/60'/0'/0/0, the same mapping as Mera's own demo
// (demos/shared/src/hd.ts) and the Monad Mera guide, so the phrase imports into MetaMask or Rabby.
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const EVM_PATH = "m/44'/60'/0'/0/0";

export function prfOutputToMnemonic(prfOutput: Uint8Array): string {
  if (prfOutput.length !== 32) throw new Error("PRF output must be 32 bytes");
  return entropyToMnemonic(prfOutput, wordlist);
}

/** Derives the account key and zeroes the PRF output and the seed before returning. */
export function prfOutputToEvmPrivateKey(prfOutput: Uint8Array): Uint8Array {
  const seed = mnemonicToSeedSync(prfOutputToMnemonic(prfOutput));
  prfOutput.fill(0);
  try {
    const node = HDKey.fromMasterSeed(seed).derive(EVM_PATH);
    if (!node.privateKey) throw new Error("BIP-32 derivation produced no private key");
    return node.privateKey;
  } finally {
    seed.fill(0);
  }
}
