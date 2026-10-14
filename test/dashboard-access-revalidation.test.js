const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
const accessFunction = dashboard.match(
    /async function enforceDashboardAccess\(\)[\s\S]*?(?=\n        function registerDashboardAccessRevalidation)/
)?.[0];

function createAccessHarness() {
    let resolveSession;
    let fetchCalls = 0;
    const classes = new Set();
    const sessionResponse = new Promise((resolve) => {
        resolveSession = resolve;
    });
    const context = {
        currentDashboardUser: null,
        document: {
            body: {
                classList: {
                    add: (name) => classes.add(name),
                    remove: (name) => classes.delete(name),
                    contains: (name) => classes.has(name)
                }
            }
        },
        fetch: () => {
            fetchCalls += 1;
            return sessionResponse;
        },
        updateDashboardAuthUI: () => {},
        window: { location: { replace: () => {} } }
    };

    vm.runInNewContext(
        `let dashboardAccessRequest = null;\n${accessFunction}\nresult = enforceDashboardAccess;`,
        context
    );

    return {
        enforceDashboardAccess: context.result,
        classes,
        fetchCalls: () => fetchCalls,
        resolveAuthenticatedSession: () => resolveSession({
            ok: true,
            json: async () => ({
                authenticated: true,
                user: { role: 'admin', username: 'beta-admin' }
            })
        })
    };
}

test('dashboard background access revalidation keeps an authorized page visible', async () => {
    const harness = createAccessHarness();

    const revalidation = harness.enforceDashboardAccess();
    const hiddenDuringRevalidation = harness.classes.has('auth-pending');
    harness.resolveAuthenticatedSession();

    assert.equal(await revalidation, true);
    assert.equal(hiddenDuringRevalidation, false);
    assert.equal(harness.classes.has('auth-pending'), false);
});

test('dashboard coalesces simultaneous focus and visibility access checks', async () => {
    const harness = createAccessHarness();

    const focusCheck = harness.enforceDashboardAccess();
    const visibilityCheck = harness.enforceDashboardAccess();
    harness.resolveAuthenticatedSession();

    assert.deepEqual(await Promise.all([focusCheck, visibilityCheck]), [true, true]);
    assert.equal(harness.fetchCalls(), 1);
});
