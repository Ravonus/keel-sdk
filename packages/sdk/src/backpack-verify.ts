/**
 * Compatibility re-exports for the pre-rename "backpack" verification API.
 *
 * The unit this module verified is branded Onchaininator now; the
 * implementation lives in `onchaininator-verify.ts`. Everything here is the
 * same code under its old name, kept so existing imports keep compiling.
 * New code should import the Onchaininator names.
 */

export {
  /** @deprecated Use {@link verifyOnchaininatorToken}. */
  verifyOnchaininatorToken as verifyBackpackToken,
} from "./onchaininator-verify.js";

export type {
  /** @deprecated Use {@link OnchaininatorCustody}. */
  OnchaininatorCustody as BackpackCustody,
  /** @deprecated Use {@link OnchaininatorLane}. */
  OnchaininatorLane as BackpackLane,
  /** @deprecated Use {@link OnchaininatorCarriage}. */
  OnchaininatorCarriage as BackpackCarriage,
  /** @deprecated Use {@link OnchaininatorCheck}. */
  OnchaininatorCheck as BackpackCheck,
  /** @deprecated Use {@link OnchaininatorReport}. */
  OnchaininatorReport as BackpackReport,
  /** @deprecated Use {@link VerifyOnchaininatorOptions}. */
  VerifyOnchaininatorOptions as VerifyBackpackOptions,
} from "./onchaininator-verify.js";
