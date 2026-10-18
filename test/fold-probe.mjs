/**
 * Test-only re-export of the Host fold, so the offline verifier can exercise the
 * real implementation instead of a copy. Not part of the installed bundle.
 *
 * The fold lives in the recovery component package (the pack's own Host half is
 * intentionally empty).
 */
export { initialState, foldInterruption, interruptionStateSchema } from '../recover/index.js'
