import { PREVIEW_CLIENT_JS } from '../src/ui/panels/artifactPicker/preview.clientJs.js';

/**
 * A minimal DOM emulator for running webview client scripts under Node,
 * strict enough to see identity bugs that `webview-script-executes.test.ts`
 * cannot: that suite's stub returns a *fresh* element from every
 * `getElementById`, so it is structurally blind to an innerHTML-replacement
 * defect. This one tracks element identity, `innerHTML` as a real
 * parse/serialize round-trip (ids, `class`, `data-*`, nesting), and event
 * bubbling — the three things a delegated-listener fix needs to be provable.
 *
 * **First non-`.test.ts` file under `test/`.** `tsconfig.json` includes
 * `test/**\/*`, `.vscode-test.mjs` globs `dist/test/**\/*.test.js` (this file
 * is imported, never collected as a suite), and `lint: "eslint src"` skips
 * `test/` entirely.
 *
 * Deliberately small: only the selectors and DOM operations the preview and
 * idle-pane client scripts actually use are supported — `#id`, `.class`,
 * `[attr]`, `[attr="value"]`, and the one compound form `.class[attr]...`
 * (a class plus one or more bracket clauses, e.g. `.create-row[data-type]`).
 * It is not a browser.
 */

// ── Internal element model ──────────────────────────────────────────────────

/** Void (self-closing, no matching close tag) HTML tags used by the client scripts. */
const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta']);

/**
 * Converts a `dataset` property name to its `data-*` attribute spelling.
 *
 * @param prop - camelCase dataset property name (e.g. `varSource`).
 * @returns kebab-case suffix (e.g. `var-source`).
 *
 * @example
 * kebabCase('varSource'); // → 'var-source'
 */
function kebabCase(prop: string): string {
    return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * One emulated DOM element. Identity is the object itself — `document.getElementById`
 * and `querySelector`/`querySelectorAll` all resolve to the *same* instance until an
 * ancestor's `innerHTML` is reassigned, which drops this subtree and mints new instances.
 */
export class ElementStub {
    children: ElementStub[] = [];
    parentElement: ElementStub | null = null;
    value: string;
    /** This element's own direct text runs (not descendants') — set at parse time by
     * `appendText`. `textContent` (below) is the real-DOM-matching recursive getter. */
    ownText = '';
    private _hidden = false;
    checked = false;
    /**
     * Minimal Node surface so `CODE_BLOCK_CLIENT_JS`'s caret restore can walk this
     * tree without throwing. `placeCaret` recurses `node.childNodes` looking for a
     * `nodeType === 3` text node; this stub models elements only, so it reports
     * ELEMENT_NODE with no children and `walk` falls straight through to the
     * `range.selectNodeContents(el)` branch that `createRange` already stubs.
     *
     * Needed because the harness passes REAL timers, so the debounced
     * `scheduleRender` fires ~150ms after an `input` — typically after the test
     * that fired it has finished, landing any throw as an uncaught exception
     * attributed to whatever suite is running then.
     */
    readonly nodeType = 1;
    readonly length = 0;
    get childNodes(): ElementStub[] { return this.children; }
    style: { setProperty: (name: string, val: string) => void; display: string } = {
        setProperty: () => { /* not asserted */ },
        display: '',
    };
    dataset: Record<string, string>;
    private readonly eventListeners = new Map<string, Array<(ev: SyntheticEvent) => void>>();

    constructor(
        public readonly tagName: string,
        public readonly attrs: Record<string, string>,
        private readonly registry: Map<string, ElementStub>,
    ) {
        this.value = attrs.value ?? '';
        // `hidden` ships as a bare boolean attribute (`hidden` present/absent) —
        // reflect it into the property immediately, same reasoning as `style.display`
        // below: a script that reads `.hidden` before ever writing it must see the
        // server-rendered state, not a stub default.
        this._hidden = 'hidden' in attrs;
        // A real DOM reflects a seeded `style="display:none;"` attribute into
        // `.style.display` immediately — this stub didn't (Finding #25), so a
        // restore round-trip reported a hidden button as visible.
        if (attrs.style) {
            const m = /display\s*:\s*([^;]+)/.exec(attrs.style);
            if (m) { this.style.display = m[1].trim(); }
        }
        this.dataset = new Proxy({} as Record<string, string>, {
            get: (_t, prop: string): string => this.attrs[`data-${kebabCase(prop)}`],
            set: (_t, prop: string, val: string): boolean => {
                this.attrs[`data-${kebabCase(prop)}`] = val;
                return true;
            },
        });
    }

    /** Real-DOM-matching: recursive over descendants, own text runs included, matching
     * the property `IDLE_CLIENT_JS` reads off a row whose label lives in a child `span`. */
    get textContent(): string {
        return this.ownText + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v: string) {
        unregisterSubtree(this.children, this.registry);
        this.children = [];
        this.ownText = v;
    }

    get id(): string { return this.attrs.id ?? ''; }

    get className(): string { return this.attrs.class ?? ''; }
    set className(v: string) { this.attrs.class = v; }

    /** Attribute↔property pair: the markup ships `hidden` as a bare attribute,
     * `IDLE_CLIENT_JS` writes `.hidden` — both directions must agree, or a test
     * reading the attribute after a script write sees stale markup. */
    get hidden(): boolean { return this._hidden; }
    set hidden(v: boolean) {
        this._hidden = v;
        if (v) { this.attrs.hidden = ''; } else { delete this.attrs.hidden; }
    }

    getAttribute(name: string): string | null { return name in this.attrs ? this.attrs[name] : null; }
    setAttribute(name: string, value: string): void { this.attrs[name] = value; }
    removeAttribute(name: string): void { delete this.attrs[name]; }
    hasAttribute(name: string): boolean { return name in this.attrs; }
    /** Real-DOM-matching: moves `node` (detaching it first) to just before `ref`, or to the end. */
    insertBefore(node: ElementStub, ref: ElementStub | null): ElementStub {
        if (node.parentElement) {
            const from = node.parentElement.children;
            from.splice(from.indexOf(node), 1);
        }
        const at = ref ? this.children.indexOf(ref) : -1;
        if (at === -1) { this.children.push(node); } else { this.children.splice(at, 0, node); }
        node.parentElement = this;
        return node;
    }

    get classList(): { contains(c: string): boolean; add(c: string): void; remove(c: string): void } {
        const self = this;
        return {
            contains: (c) => (self.attrs.class ?? '').split(/\s+/).includes(c),
            add: (c) => {
                const set = new Set((self.attrs.class ?? '').split(/\s+/).filter(Boolean));
                set.add(c);
                self.attrs.class = [...set].join(' ');
            },
            remove: (c) => {
                self.attrs.class = (self.attrs.class ?? '').split(/\s+/).filter((x) => x !== c).join(' ');
            },
        };
    }

    /** Serializes the live child tree back to markup — the snapshot `showDiffView` takes. */
    get innerHTML(): string { return serialize(this.children); }

    /** Drops the current subtree (unregistering its ids) and parses fresh, identity-new children. */
    set innerHTML(html: string) {
        unregisterSubtree(this.children, this.registry);
        this.children = parseFragment(html, this, this.registry);
    }

    addEventListener(type: string, fn: (ev: SyntheticEvent) => void): void {
        const arr = this.eventListeners.get(type) ?? [];
        arr.push(fn);
        this.eventListeners.set(type, arr);
    }
    removeEventListener(type: string, fn: (ev: SyntheticEvent) => void): void {
        const arr = this.eventListeners.get(type);
        if (!arr) { return; }
        const i = arr.indexOf(fn);
        if (i >= 0) { arr.splice(i, 1); }
    }
    listenersFor(type: string): Array<(ev: SyntheticEvent) => void> {
        return this.eventListeners.get(type) ?? [];
    }
    appendChild(child: ElementStub): ElementStub {
        this.children.push(child);
        child.parentElement = this;
        if (child.id) { this.registry.set(child.id, child); }
        return child;
    }
    remove(): void {
        if (this.parentElement) {
            const idx = this.parentElement.children.indexOf(this);
            if (idx >= 0) { this.parentElement.children.splice(idx, 1); }
        }
        if (this.id && this.registry.get(this.id) === this) { this.registry.delete(this.id); }
    }
    closest(sel: string): ElementStub | null {
        let node: ElementStub | null = this;
        while (node) {
            if (matches(node, sel)) { return node; }
            node = node.parentElement;
        }
        return null;
    }
    querySelector(sel: string): ElementStub | null { return findFirst(this, sel); }
    querySelectorAll(sel: string): ElementStub[] { return findAll(this, sel); }
    getBoundingClientRect(): { top: number; left: number; width: number; height: number } {
        return { top: 0, left: 0, width: 300, height: 600 };
    }
    setPointerCapture(): void { /* not asserted */ }
    releasePointerCapture(): void { /* not asserted */ }
    focus(): void { /* not asserted */ }
}

interface SyntheticEvent { type: string; target: ElementStub; }

/** Parses the double-quoted-attribute HTML subset the client scripts emit. */
function parseAttrs(raw: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) { attrs[m[1]] = m[2]; }
    return attrs;
}

/** Appends a text run to the currently-open element's own text, if any is open. */
function appendText(stack: ElementStub[], text: string): void {
    if (!text || stack.length === 0) { return; }
    const el = stack.at(-1)!;
    el.ownText += text;
    // Real DOM: a <textarea>'s initial value is its text content.
    if (el.tagName === 'textarea') { el.value += text; }
}

/** Pops `stack` when a closing tag matches the currently-open element. */
function closeTag(stack: ElementStub[], tag: string): void {
    if (stack.length > 0 && stack.at(-1)!.tagName === tag) { stack.pop(); }
}

/** Parses an HTML fragment into a fresh (identity-new) element tree, registering ids.
 * Plain text between tags becomes the currently-open element's `ownText` (`:53`) — this
 * element's own direct text runs only, not a recursive join. `textContent` (`:92-94`)
 * is the separate, real-DOM-matching getter that joins `ownText` plus every descendant's
 * `textContent` recursively — so a row whose label lives in a child `span` still reads
 * back correctly through `.textContent` even though `ownText` itself stays leaf-local. */
function parseFragment(html: string, parent: ElementStub, registry: Map<string, ElementStub>): ElementStub[] {
    const result: ElementStub[] = [];
    const stack: ElementStub[] = [];
    const tagRe = /<(\/)?([a-zA-Z][\w-]*)([^<>]*)>/g;
    let m: RegExpExecArray | null;
    let lastIndex = 0;
    while ((m = tagRe.exec(html)) !== null) {
        appendText(stack, html.slice(lastIndex, m.index));
        lastIndex = tagRe.lastIndex;
        const [, closing, rawTag, rest] = m;
        const tag = rawTag.toLowerCase();
        if (closing) {
            closeTag(stack, tag);
            continue;
        }
        const el = new ElementStub(tag, parseAttrs(rest), registry);
        el.parentElement = stack.length ? stack.at(-1)! : parent;
        const container = stack.length ? stack.at(-1)!.children : result;
        container.push(el);
        if (el.id) { registry.set(el.id, el); }
        const selfClosing = rest.trimEnd().endsWith('/') || VOID_TAGS.has(tag);
        if (!selfClosing) { stack.push(el); }
    }
    return result;
}

/** Serializes an element tree back to markup (the mirror of `parseFragment`). */
function serialize(nodes: ElementStub[]): string {
    return nodes.map((n) => {
        const attrStr = Object.entries(n.attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
        const open = attrStr ? `<${n.tagName} ${attrStr}>` : `<${n.tagName}>`;
        if (VOID_TAGS.has(n.tagName)) { return open; }
        return `${open}${serialize(n.children)}</${n.tagName}>`;
    }).join('');
}

/** Deep-unregisters every id in a detached subtree and severs parent links. */
function unregisterSubtree(nodes: ElementStub[], registry: Map<string, ElementStub>): void {
    for (const n of nodes) {
        if (n.id && registry.get(n.id) === n) { registry.delete(n.id); }
        unregisterSubtree(n.children, registry);
        n.parentElement = null;
    }
}

/** Tests one bracket clause (`[attr]` or `[attr="value"]`) against an element. */
function matchesAttrClause(el: ElementStub, clause: string): boolean {
    const m = /^\[([-\w:.]+)(?:="([^"]*)")?]$/.exec(clause);
    if (!m) { return false; }
    const [, name, value] = m;
    if (!(name in el.attrs)) { return false; }
    return value === undefined ? true : el.attrs[name] === value;
}

/**
 * The selector forms the client scripts use: `#id`, `.class`, `[attr]`, `[attr="value"]`,
 * plus the one compound form `IDLE_CLIENT_JS` needs — a class followed by one or more
 * bracket clauses (`.create-row[data-type]`). A class-only or bracket-only selector still
 * takes the single-form branch unchanged, so every existing caller (W1's `#varInputs`,
 * `[data-var="VK-host"]`, `#varSetApplyBtn`) matches exactly as before.
 *
 * @example
 * matches(row, '.create-row[data-type]')  // → true only with BOTH the class and the attr
 */
function matches(el: ElementStub, selector: string): boolean {
    if (selector.startsWith('#')) { return el.id === selector.slice(1); }
    if (!selector.startsWith('.')) { return matchesAttrClause(el, selector); }
    const bracketStart = selector.indexOf('[');
    if (bracketStart === -1) { return el.classList.contains(selector.slice(1)); }
    const className = selector.slice(1, bracketStart);
    const clauseRe = /\[[^[\]]*]/g;
    const clauses: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = clauseRe.exec(selector)) !== null) { clauses.push(cm[0]); }
    return el.classList.contains(className) && clauses.every((c) => matchesAttrClause(el, c));
}

function findFirst(node: ElementStub, sel: string): ElementStub | null {
    for (const c of node.children) {
        if (matches(c, sel)) { return c; }
        const found = findFirst(c, sel);
        if (found) { return found; }
    }
    return null;
}
function findAll(node: ElementStub, sel: string, out: ElementStub[] = []): ElementStub[] {
    for (const c of node.children) {
        if (matches(c, sel)) { out.push(c); }
        findAll(c, sel, out);
    }
    return out;
}

/** A permissive stand-in for any id the harness was not asked to seed — never `null`, so an
 * unguarded `document.getElementById(x).addEventListener(...)` on a non-seeded id does not throw.
 * Shape borrowed from `webview-script-executes.test.ts`'s `stubElement()`. */
function permissiveStub(): Record<string, unknown> {
    return {
        addEventListener: () => { /* not asserted */ },
        removeEventListener: () => { /* not asserted */ },
        appendChild: () => { /* not asserted */ },
        remove: () => { /* not asserted */ },
        setPointerCapture: () => { /* not asserted */ },
        releasePointerCapture: () => { /* not asserted */ },
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 300, height: 600 }),
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
        focus: () => { /* not asserted */ },
        classList: { contains: () => false, add: () => { /* not asserted */ }, remove: () => { /* not asserted */ } },
        dataset: {},
        style: { setProperty: () => { /* not asserted */ }, display: '' },
        innerHTML: '',
        textContent: '',
        value: '',
        hidden: false,
        checked: false,
        files: [],
    };
}

// ── Public surface ───────────────────────────────────────────────────────────

/** The handle a test drives a running client script through. */
export interface WebviewDom {
    /** Looks up the current live element for a selector (`#id`, `.class`, `[attr]`, `[attr="value"]`) — `null` if absent, so a test's `.value`/`.textContent`/`.classList` read needs no call-site cast. */
    el(selector: string): ElementStub | null;
    /** Every live element matching a selector, in document order — the harness's
     * `document.querySelectorAll`, exposed so a test can assert a *count* or *membership*
     * across all matches rather than only the first (`el` picks first-in-document-order,
     * which cannot prove a negative when several elements share a selector). */
    all(selector: string): ElementStub[];
    /** Dispatches a DOM event at `target`, bubbling through `parentElement` — supports delegated listeners. */
    fire(target: unknown, type: string): void;
    /** Delivers a `window.addEventListener('message', ...)` event, as the extension host would post one. */
    dispatch(message: Record<string, unknown>): void;
    /** Every `vscode.postMessage(...)` call the script made, in order. */
    posted: Array<Record<string, unknown>>;
    /** Every `vscode.setState(...)` call the script made, in order — proves persistence happened without needing a real dispose/reload round-trip. */
    stateWrites: unknown[];
}

/**
 * Builds a `WebviewDom` running `opts.script` against `opts.seedHtml`.
 *
 * @param opts.seedHtml - Initial markup; every id the script dereferences unguarded at
 *   load must be present here or the script throws during setup.
 * @param opts.script   - Client-JS bundle (e.g. `PREVIEW_CLIENT_JS`).
 * @param opts.state    - Optional — what `vscode.getState()` returns, simulating a
 *   persisted-state seed from a prior session. Optional because W1 reaches this harness
 *   exclusively through `makePreviewDom()`, which passes no `state`; a mandatory field
 *   would break that preset.
 * @returns A `WebviewDom` handle for driving and inspecting the running script.
 *
 * @example
 * const dom = makeWebviewDom({ seedHtml: '<button id="x"></button>', script: '...' });
 * dom.fire(dom.el('#x'), 'click');
 */
export function makeWebviewDom(opts: { seedHtml: string; script: string; state?: { mode?: unknown; query?: unknown } }): WebviewDom {
    const registry = new Map<string, ElementStub>();
    const root = new ElementStub('root', {}, registry);
    root.children = parseFragment(opts.seedHtml, root, registry);

    const posted: Array<Record<string, unknown>> = [];
    const winListeners = new Map<string, Array<(ev: { data: unknown }) => void>>();

    const doc = {
        getElementById: (id: string): unknown => registry.get(id) ?? permissiveStub(),
        querySelector: (sel: string): ElementStub | null => (sel.startsWith('#') ? registry.get(sel.slice(1)) ?? null : findFirst(root, sel)),
        querySelectorAll: (sel: string): ElementStub[] => findAll(root, sel),
        createElement: (tag: string): ElementStub => new ElementStub(tag, {}, registry),
        createRange: () => ({
            setStart: () => { /* stub */ },
            setEnd: () => { /* stub */ },
            collapse: () => { /* stub */ },
            selectNodeContents: () => { /* stub */ },
            toString: () => '',
        }),
        execCommand: () => true,
        addEventListener: () => { /* stub */ },
        body: permissiveStub(),
        documentElement: permissiveStub(),
    };

    const win = {
        addEventListener: (type: string, fn: (ev: { data: unknown }) => void): void => {
            const arr = winListeners.get(type) ?? [];
            arr.push(fn);
            winListeners.set(type, arr);
        },
        // `getRangeAt`/`rangeCount` included because the harness passes REAL timers
        // (`:423`), so `CODE_BLOCK_CLIENT_JS`'s debounced `scheduleRender` actually
        // fires ~150ms after an `input` — by which time the test that fired it has
        // usually finished, landing the throw as an uncaught exception attributed
        // to whatever suite happens to be running. `rangeCount: 0` makes
        // `getCaretOffset` take its documented early-return instead.
        getSelection: () => ({
            rangeCount: 0,
            getRangeAt: () => null,
            removeAllRanges: () => { /* stub */ },
            addRange: () => { /* stub */ },
        }),
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        innerWidth: 300,
        innerHeight: 600,
        screen: { availWidth: 1920, availHeight: 1080 },
        clipboardData: { getData: () => '' },
    };

    const stateWrites: unknown[] = [];
    const vscode = {
        postMessage: (m: Record<string, unknown>): void => { posted.push(m); },
        getState: (): unknown => opts.state,
        setState: (s: unknown): void => { stateWrites.push(s); },
    };

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('vscode', 'document', 'window', 'setTimeout', 'clearTimeout', opts.script);
    // Real timers — a debounced post (W1's T1.2) never fires against a no-op stub.
    fn(vscode, doc, win, setTimeout, clearTimeout);

    return {
        el: (selector: string): ElementStub | null => (selector.startsWith('#') ? registry.get(selector.slice(1)) ?? null : findFirst(root, selector)),
        all: (selector: string): ElementStub[] => findAll(root, selector),
        fire: (target: unknown, type: string): void => {
            if (!target) { return; }
            const event: SyntheticEvent = { type, target: target as ElementStub };
            let node: ElementStub | null = target as ElementStub;
            while (node) {
                for (const listener of node.listenersFor(type)) { listener(event); }
                node = node.parentElement;
            }
        },
        dispatch: (message: Record<string, unknown>): void => {
            for (const listener of winListeners.get('message') ?? []) { listener({ data: message }); }
        },
        posted,
        stateWrites,
    };
}

/** Seed markup mirroring `preview.render.ts`'s `#varsSection` block plus every id
 * `PREVIEW_CLIENT_JS` dereferences unguarded at load (`#insertBtn`, `#copyBtn`, `#editBtn`,
 * `#cancelBtn`, `#codeWrapper`). One variable, `VK-host`, is enough to exercise the flow. */
const PREVIEW_SEED_HTML = `
  <div id="varsSection">
    <div class="inputs" id="varInputs">
      <div class="input-row">
        <label for="v-VK-host">Host</label>
        <input id="v-VK-host" data-var="VK-host" type="text" value="" placeholder="Host">
      </div>
    </div>
  </div>
  <button id="insertBtn">Insert</button>
  <button id="copyBtn">Copy</button>
  <button id="editBtn">Edit</button>
  <button id="cancelBtn">Cancel</button>
  <div id="codeWrapper"></div>
`;

/** One-line preset over {@link makeWebviewDom} for the preview panel's own client script. */
export function makePreviewDom(): WebviewDom {
    return makeWebviewDom({ seedHtml: PREVIEW_SEED_HTML, script: PREVIEW_CLIENT_JS });
}
