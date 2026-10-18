/**
 * Host half of the PACK 不二布丁光子 (dsh-notpdpton).
 *
 * Deliberately empty. This package is the pack — the card on the Plugins page that
 * lists its components — so it owns the card's name and description and the bundle
 * patch that mounts each component, and nothing else. Every capability belongs to a
 * component package (`dsh-notpdpton-recover`, `dsh-notpdpton-window`), which is what
 * lets each one be switched off independently in the Plugins list.
 *
 * A bundle package still has to be importable, which is what this file is: exporting
 * `apply` with no registrations keeps the pack loadable without claiming a feature.
 *
 * @module dsh-notpdpton
 */

/** Host plugin name, used in diagnostics. */
export const name = 'notpdpton'

/** Nothing to inject: the pack registers no services and waits on none. */
export const inject = []

/**
 * Activate the pack's Host half.
 *
 * Intentionally empty: any registration here would belong to a component instead.
 */
export function apply() {}
