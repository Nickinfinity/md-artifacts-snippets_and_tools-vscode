import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { pickDestFolder, type DestPickerIO } from '../src/ui/panels/destFolderPicker.panel.js';

type Item = vscode.QuickPickItem & { uri?: vscode.Uri; isUse?: boolean; isNew?: boolean };

/**
 * A QuickPick that fires `onDidHide` exactly as the extension host does: on `hide()`, on
 * `dispose()` (synchronously), and when another input UI opens — only while it expects one.
 * A fake that skips any of these proves nothing about the picker's settle logic.
 */
class FakeHost {
    items: Item[] = [];
    selectedItems: Item[] = [];
    title = ''; placeholder = ''; ignoreFocusOut = false; busy = false;
    private accepts: Array<() => unknown> = [];
    private hides: Array<() => void> = [];
    private visible = false;
    private expecting = false;
    private disposed = false;
    disposeCalls = 0;
    shown = 0;
    boxes: Array<string | undefined> = [];
    private readonly fireDidHide = (): void => {
        if (this.expecting) { this.expecting = this.visible; this.hides.forEach(f => f()); }
    };
    readonly qp = {
        get items() { return host.items; }, set items(v: Item[]) { host.items = v; },
        get selectedItems() { return host.selectedItems; },
        set title(v: string) { host.title = v; }, set placeholder(v: string) { host.placeholder = v; },
        set ignoreFocusOut(v: boolean) { host.ignoreFocusOut = v; }, set busy(v: boolean) { host.busy = v; },
        onDidAccept: (f: () => unknown) => { host.accepts.push(f); return { dispose() { /* none */ } }; },
        onDidHide: (f: () => void) => { host.hides.push(f); return { dispose() { /* none */ } }; },
        show: () => { host.shown++; host.visible = host.expecting = true; },
        hide: () => { host.visible = false; host.fireDidHide(); },
        dispose: () => { host.disposeCalls++; if (host.disposed) { return; } host.disposed = true; host.fireDidHide(); },
    };
    readonly io = {
        createQuickPick: () => this.qp,
        showInputBox: () => { this.fireDidHide(); return Promise.resolve(this.boxes.shift()); },
    } as unknown as DestPickerIO;
    constructor() { host = this; }
    /** Selects the row with `label` containing `text` and runs every accept handler to completion. */
    async pick(text: string): Promise<void> {
        const it = this.items.find(i => i.label.includes(text));
        assert.ok(it, `no row "${text}" in ${this.items.map(i => i.label).join('|')}`);
        this.selectedItems = [it];
        await Promise.all(this.accepts.map(f => f()));
    }
    /** Polls until the picker has been shown `n` times (render is async). */
    async shownTimes(n: number): Promise<void> {
        for (let i = 0; i < 200 && this.shown < n; i++) { await new Promise(r => setTimeout(r, 5)); }
        assert.ok(this.shown >= n, `picker shown ${this.shown}x, wanted ${n}`);
    }
    escape(): void { this.qp.hide(); }
}
// eslint-disable-next-line prefer-const
let host: FakeHost;

suite('destination folder picker — settles through a host-faithful fake', () => {
    let root: string, rootUri: vscode.Uri;
    const NEW = 'New folder here', USE = 'Use this folder';
    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'mda-dest-'));
        fs.mkdirSync(path.join(root, 'Web'));
        rootUri = vscode.Uri.file(root);
    });
    teardown(() => fs.rmSync(root, { recursive: true, force: true }));

    test('(1) "Use this folder" resolves currentDir, not undefined', async () => {
        const h = new FakeHost();
        const run = pickDestFolder(rootUri, h.io);
        await h.shownTimes(1);
        await h.pick(USE);
        assert.strictEqual((await run)?.fsPath, root);
    });

    test('(2) New folder → name → re-shown inside it → Use resolves the new folder', async () => {
        const h = new FakeHost();
        const run = pickDestFolder(rootUri, h.io);
        await h.shownTimes(1);
        h.boxes.push('Fresh');
        await h.pick(NEW);
        await h.shownTimes(2);
        assert.ok(fs.statSync(path.join(root, 'Fresh')).isDirectory());
        await h.pick(USE);
        assert.strictEqual((await run)?.fsPath, path.join(root, 'Fresh'));
    });

    test('(3) Escape in the name box re-shows; a later Use works', async () => {
        const h = new FakeHost();
        const run = pickDestFolder(rootUri, h.io);
        await h.shownTimes(1);
        h.boxes.push(undefined);
        await h.pick(NEW);
        await h.shownTimes(2);
        await h.pick(USE);
        assert.strictEqual((await run)?.fsPath, root);
    });

    test('(4) Escape in the picker resolves undefined', async () => {
        const h = new FakeHost();
        const run = pickDestFolder(rootUri, h.io);
        await h.shownTimes(1);
        h.escape();
        assert.strictEqual(await run, undefined);
    });

    test('(5) a failed createDirectory re-shows and the picker still works', async () => {
        const h = new FakeHost();
        const run = pickDestFolder(rootUri, h.io);
        await h.shownTimes(1);
        fs.writeFileSync(path.join(root, 'Blocked'), 'x'); // a file in the way: createDirectory rejects
        h.boxes.push('Blocked');
        await h.pick(NEW);
        await h.shownTimes(2);
        await h.pick(USE);
        assert.strictEqual((await run)?.fsPath, root);
    });

    test('(6) dispose is idempotent and does not recurse', async () => {
        const h = new FakeHost();
        const run = pickDestFolder(rootUri, h.io);
        await h.shownTimes(1);
        await h.pick(USE);
        await run;
        h.qp.dispose();
        h.qp.dispose();
        assert.ok(h.disposeCalls < 10, `dispose called ${h.disposeCalls}x`);
    });
});
