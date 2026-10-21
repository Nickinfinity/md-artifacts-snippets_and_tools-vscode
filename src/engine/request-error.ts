import type { EngineErrorData } from '../types/engine.types.js';

/**
 * The one error every engine request rejects with — engine codes and the
 * client's own `client.*` codes alike. `message` is the bare code; words come
 * only from `engineErrorMessage` (`src/engine/errors.ts`).
 *
 * @param data - The code and its string params.
 * @returns An `Error` carrying `data`.
 * @example
 * throw new EngineRequestError({ code: 'client.timeout', params: {} });
 */
export class EngineRequestError extends Error {
    constructor(readonly data: EngineErrorData) {
        super(data.code);
        this.name = 'EngineRequestError';
    }
}
