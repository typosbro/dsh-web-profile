/**
 * voice-mode — host half.
 *
 * The whole feature lives in the browser: speech recognition, sentence chunking
 * and speech synthesis are Web APIs, and prompt submission / turn cancellation
 * go through the Session Remote the Web client already owns. The host row is a
 * no-op that exists only so the bundle has a mountable entry and can grow a
 * Config or a host route later without changing the package layout.
 *
 * @returns {void}
 */
export function apply() {}
