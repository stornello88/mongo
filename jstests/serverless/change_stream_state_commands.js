// Test that the 'setChangeStreamState' and 'getChangeStreamState' commands work as expected in the
// multi-tenant replica sets environment for various cases.
// @tags: [
//   featureFlagMongoStore,
//   requires_fcv_61,
// ]
(function() {
"use strict";

load("jstests/libs/fail_point_util.js");                    // For configureFailPoint.
load("jstests/serverless/libs/change_collection_util.js");  // For verifyChangeCollectionEntries.
load('jstests/libs/parallel_shell_helpers.js');             // For funWithArgs.

const replSetTest = new ReplSetTest({nodes: 2});

// TODO SERVER-67267 Add 'featureFlagServerlessChangeStreams' and 'serverless' flags and remove
// 'failpoint.forceEnableChangeCollectionsMode'.
replSetTest.startSet({
    setParameter: {
        "failpoint.forceEnableChangeCollectionsMode": tojson({mode: "alwaysOn"}),
        multitenancySupport: true
    }
});

replSetTest.initiate();

// Sets the change stream state for the provided tenant id.
function setChangeStreamState(tenantId, enabled) {
    assert.commandWorked(replSetTest.getPrimary().getDB("admin").runCommand(
        {setChangeStreamState: 1, $tenant: tenantId, enabled: enabled}));
}

// Verifies that the required change stream state is set for the provided tenant id both in the
// primary and the secondary and the command 'getChangeStreamState' returns the same state.
function assertChangeStreamState(tenantId, enabled) {
    assert.eq(assert
                  .commandWorked(replSetTest.getPrimary().getDB("admin").runCommand(
                      {getChangeStreamState: 1, $tenant: tenantId}))
                  .enabled,
              enabled);

    const primaryColls = replSetTest.getPrimary().getDB("config").getCollectionNames();
    const secondaryColls = replSetTest.getSecondary().getDB("config").getCollectionNames();

    // Verify that the change collection exists both in the primary and the secondary.
    assert.eq(primaryColls.includes("system.change_collection"), enabled);
    assert.eq(secondaryColls.includes("system.change_collection"), enabled);

    // Verify that the pre-images collection exists both in the primary and the secondary.
    assert.eq(primaryColls.includes("system.preimages"), enabled);
    assert.eq(secondaryColls.includes("system.preimages"), enabled);
}

const firstOrgTenantId = ObjectId();
const secondOrgTenantId = ObjectId();

// Tests that the 'setChangeStreamState' command works for the basic cases.
(function basicTest() {
    jsTestLog("Running basic tests");

    // Verify that the 'setChangeStreamState' command cannot be run with db other than the 'admin'
    // db.
    assert.commandFailedWithCode(
        replSetTest.getPrimary().getDB("config").runCommand(
            {setChangeStreamState: 1, enabled: true, $tenant: firstOrgTenantId}),
        ErrorCodes.Unauthorized);

    // Verify that the 'getChangeStreamState' command cannot be run with db other than the 'admin'
    // db.
    assert.commandFailedWithCode(replSetTest.getPrimary().getDB("config").runCommand(
                                     {getChangeStreamState: 1, $tenant: firstOrgTenantId}),
                                 ErrorCodes.Unauthorized);

    // Verify that the change stream is enabled for the tenant.
    setChangeStreamState(firstOrgTenantId, true);
    assertChangeStreamState(firstOrgTenantId, true);

    // Verify that the change stream is disabled for the tenant.
    setChangeStreamState(firstOrgTenantId, false);
    assertChangeStreamState(firstOrgTenantId, false);

    // Verify that enabling change stream multiple times has not side-effects.
    setChangeStreamState(firstOrgTenantId, true);
    setChangeStreamState(firstOrgTenantId, true);
    assertChangeStreamState(firstOrgTenantId, true);

    // Verify that disabling change stream multiple times has not side-effects.
    setChangeStreamState(firstOrgTenantId, false);
    setChangeStreamState(firstOrgTenantId, false);
    assertChangeStreamState(firstOrgTenantId, false);
})();

// Tests that the 'setChangeStreamState' command tolerates the primary step-down and can
// successfully resume after the new primary comes up.
(function resumabilityTest() {
    jsTestLog("Verifying resumability");

    // Reset the change stream state to disabled before starting the test case.
    setChangeStreamState(firstOrgTenantId, false);
    assertChangeStreamState(firstOrgTenantId, false);

    const primary = replSetTest.getPrimary();
    const secondary = replSetTest.getSecondary();

    // Hang the 'SetChangeStreamStateCoordinator' before processing the command request.
    const fpHangBeforeCmdProcessor =
        configureFailPoint(primary, "hangSetChangeStreamStateCoordinatorBeforeCommandProcessor");

    // While the failpoint is active, issue a request to enable change stream. This command will
    // hang at the fail point.
    const shellReturn = startParallelShell(() => {
        db.getSiblingDB("admin").runCommand({setChangeStreamState: 1, enabled: true});
    }, primary.port);

    // Wait until the fail point is hit.
    fpHangBeforeCmdProcessor.wait();

    // Verify that the change stream is still disabled at this point.
    assertChangeStreamState(firstOrgTenantId, false);

    // Force primary to step down such that the secondary gets elected as a new leader.
    assert.commandWorked(primary.adminCommand({replSetStepDown: 60, force: true}));

    // The hung command at the point must have been interrupted and shell must have returned the
    // error code.
    shellReturn();

    // Wait until the secondary becomes the new primary.
    replSetTest.waitForState(secondary, ReplSetTest.State.PRIMARY);

    // Disable the fail point as it is no longer needed.
    fpHangBeforeCmdProcessor.off();

    // Get the new primary and the secondary.
    const newPrimary = replSetTest.getPrimary();

    // Verify that the new primary resumed the command and change stream is now enabled.
    assert.soon(() => {
        const collNames = newPrimary.getDB("config").getCollectionNames();
        return collNames.includes("system.change_collection") &&
            collNames.includes("system.preimages");
    });
    assertChangeStreamState(firstOrgTenantId, true);
})();

// Tests that the 'setChangeStreamState' command does not allow parallel non-identical requests from
// the same tenant.
(function parallelNonIdenticalRequestsSameTenantTest() {
    jsTestLog("Verifying parallel non-identical requests from the same tenant");

    // Reset the change stream state to disabled before starting the test case.
    setChangeStreamState(firstOrgTenantId, false);
    assertChangeStreamState(firstOrgTenantId, false);

    const primary = replSetTest.getPrimary();

    // Hang the 'SetChangeStreamStateCoordinator' before processing the command request.
    const fpHangBeforeCmdProcessor =
        configureFailPoint(primary, "hangSetChangeStreamStateCoordinatorBeforeCommandProcessor");

    // While the failpoint is active, issue a request to enable change stream for the tenant. This
    // command will hang at the fail point.
    const shellReturn = startParallelShell(
        funWithArgs((firstOrgTenantId) => {
            assert.commandWorked(db.getSiblingDB("admin").runCommand(
                {setChangeStreamState: 1, $tenant: firstOrgTenantId, enabled: true}));
        }, firstOrgTenantId), primary.port);

    // Wait until the fail point is hit.
    fpHangBeforeCmdProcessor.wait();

    // While the first command is still hung, issue a request to disable the change stream for the
    // same tenants. This request should bail out with 'ConflictingOperationInProgress' exception.
    assert.throwsWithCode(() => setChangeStreamState(firstOrgTenantId, false),
                          ErrorCodes.ConflictingOperationInProgress);

    // Turn off the fail point.
    fpHangBeforeCmdProcessor.off();

    // Wait for the shell to return.
    shellReturn();

    // Verify that the first command has enabled the change stream now.
    assertChangeStreamState(firstOrgTenantId, true);
})();

// Tests that the 'setChangeStreamState' command allows parallel identical requests from the same
// tenant.
(function parallelIdenticalRequestsSameTenantTest() {
    jsTestLog("Verifying parallel identical requests from the same tenant");

    // Reset the change stream state to disabled before starting the test case.
    setChangeStreamState(firstOrgTenantId, false);
    assertChangeStreamState(firstOrgTenantId, false);

    const primary = replSetTest.getPrimary();

    // Hang the 'SetChangeStreamStateCoordinator' before processing the command request.
    const fpHangBeforeCmdProcessor =
        configureFailPoint(primary, "hangSetChangeStreamStateCoordinatorBeforeCommandProcessor");

    const shellFn = (firstOrgTenantId) => {
        assert.commandWorked(db.getSiblingDB("admin").runCommand(
            {setChangeStreamState: 1, $tenant: firstOrgTenantId, enabled: true}));
    };

    // While the failpoint is active, issue a request to enable change stream for the tenant. This
    // command will hang at the fail point.
    const shellReturn1 = startParallelShell(funWithArgs(shellFn, firstOrgTenantId), primary.port);

    // Wait for the fail point to be hit.
    fpHangBeforeCmdProcessor.wait();

    // Issue another request to enable the change stream from the same tenant. This should not throw
    // any exception. We will not wait for the fail point because the execution of the same request
    // is already in progress and this request will wait on the completion of the previous
    // enablement request.
    const shellReturn2 = startParallelShell(funWithArgs(shellFn, firstOrgTenantId), primary.port);

    // Turn off the fail point.
    fpHangBeforeCmdProcessor.off();

    // Wait for shells to return.
    shellReturn1();
    shellReturn2();

    // Verify that the first command has enabled the change stream now.
    assertChangeStreamState(firstOrgTenantId, true);
})();

// Tests that parallel requests from different tenants do not interfere with each other and can
// complete successfully.
(function parallelRequestsDifferentTenantsTest() {
    jsTestLog("Verifying parallel requests from different tenants");

    // Reset the change stream state to disable before starting the test case.
    setChangeStreamState(firstOrgTenantId, false);
    assertChangeStreamState(firstOrgTenantId, false);
    setChangeStreamState(secondOrgTenantId, false);
    assertChangeStreamState(secondOrgTenantId, false);

    const primary = replSetTest.getPrimary();

    // Hang the 'SetChangeStreamStateCoordinator' before processing the command request.
    const fpHangBeforeCmdProcessor =
        configureFailPoint(primary, "hangSetChangeStreamStateCoordinatorBeforeCommandProcessor");

    // Enable the change stream for the tenant 'firstOrgTenantId' in parallel.
    const firstTenantShellReturn = startParallelShell(
        funWithArgs((firstOrgTenantId) => {
            assert.commandWorked(db.getSiblingDB("admin").runCommand(
                {setChangeStreamState: 1, $tenant: firstOrgTenantId, enabled: true}));
        }, firstOrgTenantId), primary.port);

    // Wait until the above request hits the fail point.
    fpHangBeforeCmdProcessor.wait({timesEntered: 1});

    // While the first request from the tenant 'firstOrgTenantId' is hung, issue another request but
    // with the tenant 'secondOrgTenantId'.
    const secondTenantShellReturn = startParallelShell(
        funWithArgs((secondOrgTenantId) => {
            assert.commandWorked(db.getSiblingDB("admin").runCommand(
                {setChangeStreamState: 1, $tenant: secondOrgTenantId, enabled: true}));
        }, secondOrgTenantId), primary.port);

    // The request from the 'secondOrgTenantId' will also hang.
    fpHangBeforeCmdProcessor.wait({timesEntered: 2});

    // Now that both the request have hit the fail point, disable it.
    fpHangBeforeCmdProcessor.off();

    // Wait for both shells to return.
    firstTenantShellReturn();
    secondTenantShellReturn();

    // Verify that the change stream state for both tenants is now enabled.
    assertChangeStreamState(firstOrgTenantId, true);
    assertChangeStreamState(secondOrgTenantId, true);
})();

replSetTest.stopSet();
}());
