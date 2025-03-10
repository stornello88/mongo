/**
 * Tests the currentOp command during a shard merge protocol. A tenant migration is started, and the
 * currentOp command is tested as the recipient moves through below state sequence.
 *
 * kStarted ---> kLearnedFilenames ---> kConsistent ---> kDone.
 *
 * @tags: [
 *   featureFlagShardMerge,
 *   incompatible_with_macos,
 *   incompatible_with_windows_tls,
 *   requires_majority_read_concern,
 *   requires_persistence,
 *   requires_fcv_61,
 *   serverless,
 * ]
 */

(function() {

"use strict";
load("jstests/libs/uuid_util.js");        // For extractUUIDFromObject().
load("jstests/libs/fail_point_util.js");  // For configureFailPoint().
load("jstests/libs/parallelTester.js");   // For the Thread().
load("jstests/replsets/libs/tenant_migration_test.js");
load("jstests/replsets/libs/tenant_migration_util.js");

const tenantMigrationTest = new TenantMigrationTest({name: jsTestName()});

const kMigrationId = UUID();
const kTenantId = 'testTenantId';
const kReadPreference = {
    mode: "primary"
};
const migrationOpts = {
    migrationIdString: extractUUIDFromObject(kMigrationId),
    readPreference: kReadPreference
};

const recipientPrimary = tenantMigrationTest.getRecipientPrimary();

// Initial inserts to test cloner stats.
const dbsToClone = ["db0", "db1", "db2"];
const collsToClone = ["coll0", "coll1"];
const docs = [...Array(10).keys()].map((i) => ({x: i}));
for (const db of dbsToClone) {
    const tenantDB = tenantMigrationTest.tenantDB(kTenantId, db);
    for (const coll of collsToClone) {
        tenantMigrationTest.insertDonorDB(tenantDB, coll, docs);
    }
}

// Makes sure the fields that are always expected to exist, such as the donorConnectionString, are
// correct.
function checkStandardFieldsOK(res) {
    assert.eq(res.inprog.length, 1, res);
    assert.eq(bsonWoCompare(res.inprog[0].instanceID, kMigrationId), 0, res);
    assert.eq(res.inprog[0].donorConnectionString, tenantMigrationTest.getDonorRst().getURL(), res);
    assert.eq(bsonWoCompare(res.inprog[0].readPreference, kReadPreference), 0, res);
    // We don't test failovers in this test so we don't expect these counters to be incremented.
    assert.eq(res.inprog[0].numRestartsDueToDonorConnectionFailure, 0, res);
    assert.eq(res.inprog[0].numRestartsDueToRecipientFailure, 0, res);
}

// Check currentOp fields' expected value once the recipient is in state "consistent" or later.
function checkPostConsistentFieldsOK(res) {
    const currOp = res.inprog[0];
    assert(currOp.hasOwnProperty("startFetchingDonorOpTime") &&
               checkOptime(currOp.startFetchingDonorOpTime),
           res);
    assert(currOp.hasOwnProperty("startApplyingDonorOpTime") &&
               checkOptime(currOp.startApplyingDonorOpTime),
           res);
    assert(currOp.hasOwnProperty("cloneFinishedRecipientOpTime") &&
               checkOptime(currOp.cloneFinishedRecipientOpTime),
           res);
    // Not applicable to shard merge protocol.
    assert(!currOp.hasOwnProperty("dataConsistentStopDonorOpTime"));
}

// Validates the fields of an optime object.
function checkOptime(optime) {
    assert(optime.ts instanceof Timestamp);
    assert(optime.t instanceof NumberLong);
    return true;
}

// Set all failPoints up on the recipient's end to block the migration at certain points. The
// migration will be unblocked through the test to allow transitions to different states.
jsTestLog("Setting up all failPoints.");

const fpAfterPersistingStateDoc =
    configureFailPoint(recipientPrimary,
                       "fpAfterPersistingTenantMigrationRecipientInstanceStateDoc",
                       {action: "hang"});
const fpAfterRetrievingStartOpTime = configureFailPoint(
    recipientPrimary, "fpAfterRetrievingStartOpTimesMigrationRecipientInstance", {action: "hang"});
const fpAfterDataConsistent = configureFailPoint(
    recipientPrimary, "fpAfterDataConsistentMigrationRecipientInstance", {action: "hang"});
const fpAfterForgetMigration = configureFailPoint(
    recipientPrimary, "fpAfterReceivingRecipientForgetMigration", {action: "hang"});

jsTestLog(`Starting tenant migration with migrationId: ${kMigrationId}`);
assert.commandWorked(
    tenantMigrationTest.startMigration(migrationOpts, {enableDonorStartMigrationFsync: true}));

const fpBeforePersistingRejectReadsBeforeTimestamp = configureFailPoint(
    recipientPrimary, "fpBeforePersistingRejectReadsBeforeTimestamp", {action: "hang"});

{
    // Wait until a current operation corresponding to "tenant recipient migration" with state
    // kStarted is visible on the recipientPrimary.
    jsTestLog("Waiting until current operation with state kStarted is visible.");
    fpAfterPersistingStateDoc.wait();

    let res = recipientPrimary.adminCommand({currentOp: true, desc: "tenant recipient migration"});
    checkStandardFieldsOK(res);
    let currOp = res.inprog[0];
    assert.eq(currOp.state, TenantMigrationTest.RecipientStateEnum.kStarted, res);
    assert.eq(currOp.garbageCollectable, false, res);
    assert.eq(currOp.dataSyncCompleted, false, res);
    assert(!currOp.hasOwnProperty("startFetchingDonorOpTime"), res);
    assert(!currOp.hasOwnProperty("startApplyingDonorOpTime"), res);
    assert(!currOp.hasOwnProperty("expireAt"), res);
    assert(!currOp.hasOwnProperty("donorSyncSource"), res);
    assert(!currOp.hasOwnProperty("cloneFinishedRecipientOpTime"), res);
    // Not applicable to shard merge protocol.
    assert(!currOp.hasOwnProperty("dataConsistentStopDonorOpTime"), res);

    fpAfterPersistingStateDoc.off();
}

{
    // Allow the migration to move to the point where the startFetchingDonorOpTime has been
    // obtained.
    jsTestLog("Waiting for startFetchingDonorOpTime to exist.");
    fpAfterRetrievingStartOpTime.wait();

    let res = recipientPrimary.adminCommand({currentOp: true, desc: "tenant recipient migration"});
    checkStandardFieldsOK(res);
    let currOp = res.inprog[0];
    assert.gt(new Date(), currOp.receiveStart, tojson(res));

    assert.eq(currOp.state, TenantMigrationTest.RecipientStateEnum.kLearnedFilenames, res);

    assert.eq(currOp.garbageCollectable, false, res);
    assert.eq(currOp.dataSyncCompleted, false, res);
    assert(!currOp.hasOwnProperty("expireAt"), res);
    assert(!currOp.hasOwnProperty("cloneFinishedRecipientOpTime"), res);
    assert(currOp.hasOwnProperty("startFetchingDonorOpTime") &&
               checkOptime(currOp.startFetchingDonorOpTime),
           res);
    assert(currOp.hasOwnProperty("startApplyingDonorOpTime") &&
               checkOptime(currOp.startApplyingDonorOpTime),
           res);
    assert(currOp.hasOwnProperty("donorSyncSource") && typeof currOp.donorSyncSource === 'string',
           res);
    // Not applicable to shard merge protocol.
    assert(!currOp.hasOwnProperty("dataConsistentStopDonorOpTime"), res);

    fpAfterRetrievingStartOpTime.off();
}

{
    // Wait for the "kConsistent" state to be reached.
    jsTestLog("Waiting for the kConsistent state to be reached.");
    fpAfterDataConsistent.wait();

    let res = recipientPrimary.adminCommand({currentOp: true, desc: "tenant recipient migration"});
    checkStandardFieldsOK(res);
    checkPostConsistentFieldsOK(res);
    let currOp = res.inprog[0];
    // State should have changed.
    assert.eq(currOp.state, TenantMigrationTest.RecipientStateEnum.kConsistent, res);
    assert.eq(currOp.garbageCollectable, false, res);
    assert.eq(currOp.dataSyncCompleted, false, res);
    assert(!currOp.hasOwnProperty("expireAt"), res);

    // Wait to receive recipientSyncData with returnAfterReachingDonorTimestamp.
    fpAfterDataConsistent.off();
    fpBeforePersistingRejectReadsBeforeTimestamp.wait();

    res = recipientPrimary.adminCommand({currentOp: true, desc: "tenant recipient migration"});
    checkStandardFieldsOK(res);
    checkPostConsistentFieldsOK(res);
    currOp = res.inprog[0];
    // State should have changed.
    assert.eq(currOp.state, TenantMigrationTest.RecipientStateEnum.kConsistent, res);
    assert.eq(currOp.garbageCollectable, false, res);
    assert.eq(currOp.dataSyncCompleted, false, res);
    assert(!currOp.hasOwnProperty("expireAt"), res);
    // The oplog applier should have applied at least the noop resume token.
    assert.gte(currOp.numOpsApplied, 1, tojson(res));
    fpBeforePersistingRejectReadsBeforeTimestamp.off();

    jsTestLog("Waiting for migration to complete.");
    TenantMigrationTest.assertCommitted(
        tenantMigrationTest.waitForMigrationToComplete(migrationOpts));
}

jsTestLog("Issuing a forget migration command.");
const forgetMigrationThread =
    new Thread(TenantMigrationUtil.forgetMigrationAsync,
               migrationOpts.migrationIdString,
               TenantMigrationUtil.createRstArgs(tenantMigrationTest.getDonorRst()),
               true /* retryOnRetryableErrors */);
forgetMigrationThread.start();

{
    jsTestLog("Waiting for the recipient to receive the forgetMigration, and pause at failpoint");
    fpAfterForgetMigration.wait();

    let res = recipientPrimary.adminCommand({currentOp: true, desc: "tenant recipient migration"});
    checkStandardFieldsOK(res);
    checkPostConsistentFieldsOK(res);
    let currOp = res.inprog[0];
    assert.eq(currOp.state, TenantMigrationTest.RecipientStateEnum.kConsistent, res);
    assert.eq(currOp.garbageCollectable, false, res);
    // dataSyncCompleted should have changed.
    assert.eq(currOp.dataSyncCompleted, true, res);
    assert(!currOp.hasOwnProperty("expireAt"), res);

    jsTestLog("Allow the forgetMigration to complete.");
    fpAfterForgetMigration.off();
    assert.commandWorked(forgetMigrationThread.returnData());

    res = recipientPrimary.adminCommand({currentOp: true, desc: "tenant recipient migration"});
    checkStandardFieldsOK(res);
    checkPostConsistentFieldsOK(res);
    currOp = res.inprog[0];
    assert.eq(currOp.dataSyncCompleted, true, res);
    // State, completion status and expireAt should have changed.
    assert.eq(currOp.state, TenantMigrationTest.RecipientStateEnum.kDone, res);
    assert.eq(currOp.garbageCollectable, true, res);
    assert(currOp.hasOwnProperty("expireAt") && currOp.expireAt instanceof Date, res);
}

tenantMigrationTest.stop();
})();
