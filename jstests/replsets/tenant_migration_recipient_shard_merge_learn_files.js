/**
 * Tests that recipient is able to learn files to be imported from donor for shard merge protocol.
 *
 * @tags: [
 *   incompatible_with_macos,
 *   incompatible_with_windows_tls,
 *   requires_majority_read_concern,
 *   requires_persistence,
 *   serverless,
 *   featureFlagShardMerge,
 * ]
 */

(function() {
"use strict";

load("jstests/libs/fail_point_util.js");
load("jstests/libs/uuid_util.js");
load("jstests/replsets/libs/tenant_migration_test.js");
load("jstests/replsets/libs/tenant_migration_util.js");

const tenantMigrationTest =
    new TenantMigrationTest({name: jsTestName(), sharedOptions: {nodes: 3}});

const recipientPrimary = tenantMigrationTest.getRecipientPrimary();

jsTestLog(
    "Test that recipient state is correctly set to 'learned filenames' after creating the backup cursor");
const tenantId = "testTenantId";
const tenantDB = tenantMigrationTest.tenantDB(tenantId, "DB");
const collName = "testColl";

const donorPrimary = tenantMigrationTest.getDonorPrimary();

// Do a majority write.
tenantMigrationTest.insertDonorDB(tenantDB, collName);

const failpoint = "fpBeforeMarkingCloneSuccess";
const waitInFailPoint = configureFailPoint(recipientPrimary, failpoint, {action: "hang"});

const migrationUuid = UUID();
const migrationOpts = {
    migrationIdString: extractUUIDFromObject(migrationUuid),
    readPreference: {mode: 'primary'}
};

jsTestLog(`Starting the tenant migration to wait in failpoint: ${failpoint}`);
assert.commandWorked(
    tenantMigrationTest.startMigration(migrationOpts, {enableDonorStartMigrationFsync: true}));

waitInFailPoint.wait();

tenantMigrationTest.assertRecipientNodesInExpectedState({
    nodes: tenantMigrationTest.getRecipientRst().nodes,
    migrationId: migrationUuid,
    tenantId,
    expectedState: TenantMigrationTest.RecipientState.kLearnedFilenames,
    expectedAccessState: TenantMigrationTest.RecipientAccessState.kReject
});

waitInFailPoint.off();

TenantMigrationTest.assertCommitted(tenantMigrationTest.waitForMigrationToComplete(migrationOpts));

const donorPrimaryCountDocumentsResult = donorPrimary.getDB(tenantDB)[collName].countDocuments({});
const donorPrimaryCountResult = donorPrimary.getDB(tenantDB)[collName].count();

tenantMigrationTest.getRecipientRst().nodes.forEach(node => {
    // Use "countDocuments" to check actual docs, "count" to check sizeStorer data.
    assert.eq(donorPrimaryCountDocumentsResult,
              node.getDB(tenantDB)[collName].countDocuments({}),
              "countDocuments");
    assert.eq(donorPrimaryCountResult, node.getDB(tenantDB)[collName].count(), "count");
});

tenantMigrationTest.stop();
})();
