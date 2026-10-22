import * as assert from 'node:assert';
import { captureTerminal, type TerminalCaptureBag } from '../src/commands/capture/terminal.capture.js';
import type { PrefillFn } from '../src/commands/capture/editor.capture.js';
import type { EngineModel } from '../src/types/engine.types.js';

/**
 * Unit tests for `captureTerminal` (VSX-210). Pure over an injected bag — no
 * `vscode` import in the module under test, so these run with plain fakes.
 */

/**
 * Builds a fake `TerminalCaptureBag` backed by a plain mutable clipboard
 * string, plus knobs for the scenarios below.
 */
function makeFakeBag(opts: {
    clipboard?: string;
    hasActiveTerminal?: boolean;
    onCopySelection?: () => void;
} = {}): TerminalCaptureBag & { clipboard: string } {
    const bag = {
        clipboard: opts.clipboard ?? '',
        async readClipboard(): Promise<string> {
            return bag.clipboard;
        },
        async writeClipboard(text: string): Promise<void> {
            bag.clipboard = text;
        },
        async copySelection(): Promise<void> {
            opts.onCopySelection?.();
        },
        hasActiveTerminal(): boolean {
            return opts.hasActiveTerminal ?? true;
        },
    };
    return bag;
}

const model = (code: string, language = ''): EngineModel => ({ artifactType: 'Command', blocks: [{ code, language }] });
/** Echoes the sent text back as the engine's model (language rules are engine-owned: op cases `terminal`, `terminal_hidden`). */
const echo: PrefillFn = async p => model(p.text);

suite('captureTerminal', () => {
    test('clipboard changed by copySelection → source selection, clipboard restored', async () => {
        const bag = {
            clipboard: 'user-had-this',
            async readClipboard() { return bag.clipboard; },
            async writeClipboard(text: string) { bag.clipboard = text; },
            async copySelection() { bag.clipboard = 'git status'; },
            hasActiveTerminal: () => true,
        };

        const result = await captureTerminal(bag, 'Command', echo);
        assert.strictEqual(result?.source, 'selection');
        assert.strictEqual(result?.prefill.blocks?.[0]?.code, 'git status');
        assert.strictEqual(bag.clipboard, 'user-had-this');
    });

    test('clipboard unchanged by copySelection → source clipboard (user’s own content)', async () => {
        const bag = makeFakeBag({ clipboard: 'echo hi' }); // copySelection is a no-op here

        const result = await captureTerminal(bag, 'Command', echo);
        assert.strictEqual(result?.source, 'clipboard');
        assert.strictEqual(result?.prefill.blocks?.[0]?.code, 'echo hi');
        assert.strictEqual(bag.clipboard, 'echo hi');
    });

    test('no active terminal → skips copySelection, uses saved clipboard as source clipboard', async () => {
        let copyCalled = false;
        const bag = makeFakeBag({
            clipboard: 'echo hi',
            hasActiveTerminal: false,
            onCopySelection: () => { copyCalled = true; },
        });

        const result = await captureTerminal(bag, 'Command', echo);
        assert.strictEqual(copyCalled, false);
        assert.strictEqual(result?.source, 'clipboard');
    });

    test('nothing to capture → undefined', async () => {
        const bag = makeFakeBag({ clipboard: '', hasActiveTerminal: false });
        assert.strictEqual(await captureTerminal(bag, 'Command', echo), undefined);
    });

    test('sends exactly {source:terminal, type, text}', async () => {
        const sent: unknown[] = [];
        const bag = makeFakeBag({ clipboard: 'ls', hasActiveTerminal: false });
        await captureTerminal(bag, 'AIPrompt', async p => { sent.push(p); return model('ls', 'markdown'); });
        assert.deepStrictEqual(sent, [{ source: 'terminal', type: 'AIPrompt', text: 'ls' }]);
    });

    test('clipboard restored even when prefill fails (throws or refuses)', async () => {
        const bag = makeFakeBag({ clipboard: 'user-had-this', hasActiveTerminal: true, onCopySelection: () => { bag.clipboard = 'sel'; } });
        await assert.rejects(() => captureTerminal(bag, 'Command', async () => { throw new Error('engine down'); }), /engine down/);
        assert.strictEqual(bag.clipboard, 'user-had-this');
        assert.strictEqual(await captureTerminal(bag, 'Command', async () => undefined), undefined);
        assert.strictEqual(bag.clipboard, 'user-had-this');
    });

    test('clipboard restored even when copySelection throws', async () => {
        const bag = {
            clipboard: 'user-had-this',
            async readClipboard() { return bag.clipboard; },
            async writeClipboard(text: string) { bag.clipboard = text; },
            async copySelection() { throw new Error('boom'); },
            hasActiveTerminal: () => true,
        };

        await assert.rejects(() => captureTerminal(bag, 'Command', echo), /boom/);
        assert.strictEqual(bag.clipboard, 'user-had-this');
    });
});
