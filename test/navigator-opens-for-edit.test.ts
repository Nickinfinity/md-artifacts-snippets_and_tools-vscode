import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * T7.3 — guards that `opensForEdit` types (Variables) route to the var-set
 * edit form instead of the insert preview, in both the accept handler and the
 * hover (active-change) handler.
 *
 * `ArtifactNavigator` is not exported and its relevant methods are private,
 * so behaviour cannot be asserted by import — these are source-order guards
 * over the raw file text, the same seam `test/edit-artifact.test.ts:380-385`
 * uses. Each anchor's uniqueness inside its slice is asserted before it is
 * used to anchor an `indexOf` comparison, per plan instruction.
 */
suite('navigator — opensForEdit routing (source order)', () => {

    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactPicker', 'navigator.ts'),
        'utf8',
    );

    /** Occurrences of `needle` inside `slice`. */
    function occurrences(slice: string, needle: string): number {
        return slice.split(needle).length - 1;
    }

    // ── handleAccept slice ────────────────────────────────────────────────

    const acceptStart = source.indexOf('private async handleAccept');
    const acceptNextMember = source.indexOf('\n    private ', acceptStart);
    const acceptSlice = source.slice(acceptStart, acceptNextMember);

    test('setup: isIndexArtifact( is unique inside the handleAccept slice', () => {
        assert.strictEqual(occurrences(acceptSlice, 'isIndexArtifact('), 1);
    });

    test('setup: opensForEdit( is unique inside the handleAccept slice', () => {
        assert.strictEqual(occurrences(acceptSlice, 'opensForEdit('), 1);
    });

    test('setup: isMultiBlockNav( is unique inside the handleAccept slice', () => {
        assert.strictEqual(occurrences(acceptSlice, 'isMultiBlockNav('), 1);
    });

    test('opensForEdit( runs between isIndexArtifact( and isMultiBlockNav( in handleAccept', () => {
        const idxIndex = acceptSlice.indexOf('isIndexArtifact(');
        const editIndex = acceptSlice.indexOf('opensForEdit(');
        const multiIndex = acceptSlice.indexOf('isMultiBlockNav(');
        assert.ok(idxIndex < editIndex, 'opensForEdit( must come after isIndexArtifact(');
        assert.ok(editIndex < multiIndex, 'opensForEdit( must come before isMultiBlockNav(');
    });

    test('the opensForEdit branch routes to the edit form, not handoffToPreview', () => {
        // openVarSetFormPanel is called from the routed-to method (openEditForm),
        // mirroring the existing isIndexArtifact( -> this.runIndex( pattern one
        // branch above. Pinned two ways, both measurable and neither global:
        // (a) handleAccept's own slice references openEditForm; (b) openEditForm's
        // own body (sliced separately below) is what actually calls
        // openVarSetFormPanel — a whole-file `source.includes` would pass for a
        // call placed on any wrong branch, so it is deliberately not used here.
        assert.ok(acceptSlice.includes('this.openEditForm('), 'handleAccept does not call this.openEditForm(');

        const openEditFormStart = source.indexOf('private openEditForm(');
        assert.ok(openEditFormStart >= 0, 'openEditForm method not found');
        const openEditFormNextMember = source.indexOf('\n    private ', openEditFormStart);
        assert.ok(openEditFormNextMember >= 0, 'no next private member after openEditForm');
        const openEditFormBody = source.slice(openEditFormStart, openEditFormNextMember);
        assert.ok(openEditFormBody.includes('openVarSetFormPanel'), 'openEditForm does not call openVarSetFormPanel');

        const editIndex = acceptSlice.indexOf('opensForEdit(');
        const multiIndex = acceptSlice.indexOf('isMultiBlockNav(');
        const between = acceptSlice.slice(editIndex, multiIndex);
        assert.ok(!between.includes('handoffToPreview'), 'opensForEdit branch must not fall through to handoffToPreview');
    });

    test('the opensForEdit branch returns before isMultiBlockNav( is reached', () => {
        const editIndex = acceptSlice.indexOf('opensForEdit(');
        const multiIndex = acceptSlice.indexOf('isMultiBlockNav(');
        const between = acceptSlice.slice(editIndex, multiIndex);
        assert.ok(between.includes('return'), 'opensForEdit branch must return, or it falls through to isMultiBlockNav');
    });

    // ── handleActiveChange slice (hover route) ────────────────────────────

    const activeStart = source.indexOf('private async handleActiveChange');
    // The method's own close, not the next member — the next `\n    private `
    // lands inside isMultiBlockNav's JSDoc, past the method body (plan-flagged pitfall).
    const activeEnd = source.indexOf('\n\n    /**', activeStart);
    const activeSlice = source.slice(activeStart, activeEnd);

    suiteSetup(() => {
        assert.ok(acceptStart >= 0, 'handleAccept not found');
        assert.ok(acceptNextMember >= 0, 'no next private member after handleAccept');
        assert.ok(activeStart >= 0, 'handleActiveChange not found');
        assert.ok(activeEnd >= 0, 'no method-close marker found after handleActiveChange');
    });

    test('setup: isMultiBlockNav( occurs exactly once inside the handleActiveChange slice', () => {
        assert.strictEqual(occurrences(activeSlice, 'isMultiBlockNav('), 1);
    });

    test('setup: opensForEdit( occurs inside the handleActiveChange slice', () => {
        assert.ok(occurrences(activeSlice, 'opensForEdit(') >= 1);
    });

    test('opensForEdit( runs before isMultiBlockNav( in handleActiveChange, and uses showEmpty', () => {
        const editIndex = activeSlice.indexOf('opensForEdit(');
        const multiIndex = activeSlice.indexOf('isMultiBlockNav(');
        assert.ok(editIndex < multiIndex, 'opensForEdit( must come before isMultiBlockNav( in handleActiveChange');

        const between = activeSlice.slice(editIndex, multiIndex);
        assert.ok(between.includes('showEmpty'), 'opensForEdit branch in handleActiveChange must call showEmpty');
    });

    test('setup: const key = item.uri.toString(); is unique inside the handleActiveChange slice', () => {
        // `this.lastPreviewedUri = key;` is NOT usable as the anchor here — it
        // occurs twice in this slice (once in the earlier item?.block branch,
        // whose `key` is a different local of the same name), so indexOf would
        // resolve to the wrong occurrence and the ordering assertion below
        // would pass regardless of where the opensForEdit branch actually sits.
        assert.strictEqual(occurrences(activeSlice, 'const key = item.uri.toString();'), 1);
    });

    test('opensForEdit branch in handleActiveChange runs after the uri key is computed', () => {
        const keyIndex = activeSlice.indexOf('const key = item.uri.toString();');
        const editIndex = activeSlice.indexOf('opensForEdit(');
        assert.ok(keyIndex >= 0, 'const key = item.uri.toString(); not found');
        assert.ok(keyIndex < editIndex, 'opensForEdit branch must come after const key = item.uri.toString();');
    });
});
