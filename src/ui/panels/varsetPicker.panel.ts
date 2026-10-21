import { VarSetScanner } from '../../services/varset.service.js';

/** Module-private scanner singleton — cache survives across callers. */
const sharedScanner = new VarSetScanner();

/**
 * Returns the shared `VarSetScanner` instance so the orchestrator can call
 * `invalidate()` after writing a new variable-set file.
 *
 * @returns The module-level scanner singleton.
 *
 * @example
 * getVarSetScanner().invalidate();
 */
export function getVarSetScanner(): VarSetScanner {
    return sharedScanner;
}
