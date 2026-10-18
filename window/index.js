/**
 * Host half of 窗口位置与尺寸记忆 (dsh-notpdpton-window).
 *
 * Deliberately empty. Maintaining the main window's position and size is a pure
 * renderer concern: the Desktop shell creates its BrowserWindow in the Electron
 * main process with hardcoded bounds and exposes no geometry IPC, and a Host half
 * runs in a plain Node child, so neither can reach the window. The browser half
 * (this package's ./client) receives the Window Management API, the persisted
 * geometry and the runtime binder; the Host contributes nothing to it.
 *
 * A bundle row still needs a Host module to mount, which is what this file is:
 * exporting `apply` with no registrations keeps the row active and the component
 * listed on the Plugins page.
 *
 * @module dsh-notpdpton-window
 */

/** Host plugin name, used in diagnostics. */
export const name = 'notpdptonWindow'

/** Nothing to inject: this half registers no services and waits on none. */
export const inject = []

/**
 * Activate the Host half.
 *
 * Intentionally empty: the component is entirely a browser feature, and an effect
 * that registered anything here would have no consumer.
 */
export function apply() {}
