/**
 * Basic test to make sure events from timeseries buckets collections look normal and don't get
 * filtered.
 * @tags: [
 *     change_stream_does_not_expect_txns,
 *     assumes_unsharded_collection,
 * ]
 */
(function() {
"use strict";

load("jstests/libs/change_stream_util.js");  // For ChangeStreamTest.
load("jstests/libs/feature_flag_util.js");

let testDB = db.getSiblingDB(jsTestName());
testDB.dropDatabase();
let dbName = testDB.getName();

let coll = testDB[jsTestName()];
let collName = coll.getName();
let bucketsCollName = "system.buckets." + collName;

let cst = new ChangeStreamTest(testDB);
let curWithEvents = cst.startWatchingChanges({
    pipeline: [
        {$changeStream: {showExpandedEvents: true, showSystemEvents: true}},
        {
            $project: {
                documentKey: 0,
                "fullDocument._id": 0,
                collectionUUID: 0,
                "stateBeforeChange.collectionOptions.uuid": 0,
                clusterTime: 0,
                wallTime: 0
            }
        },
        {$match: {operationType: {$regex: "(?!shard)", $options: "i"}}}
    ],
    collection: 1
});
let curNoEvents = testDB.watch([], {showExpandedEvents: true});

assert.commandWorked(testDB.createCollection(
    jsTestName(),
    {timeseries: {timeField: "ts", metaField: "meta"}}));    // on buckets ns and view ns
coll.createIndex({ts: 1, "meta.b": 1}, {name: "dropMe"});    // on buckets ns
coll.insertOne({_id: 1, ts: new Date(1000), meta: {a: 1}});  // on buckets ns
coll.insertOne({_id: 1, ts: new Date(1000), meta: {a: 1}});  // on buckets ns
coll.update({"meta.a": 1}, {$set: {"meta.b": 2}});           // on buckets ns
coll.remove({"meta.a": 1});                                  // on buckets ns
// collMod granularity. on both buckets ns and view ns
assert.commandWorked(testDB.runCommand({collMod: collName, timeseries: {granularity: "hours"}}));
// collMod expiration. just on buckets ns
assert.commandWorked(testDB.runCommand({collMod: collName, expireAfterSeconds: 1}));
coll.dropIndex("dropMe");  // on buckets ns
coll.drop();               // on buckets ns and view ns

// document key, _id, uuid, cluster and wall times omitted
let expectedChanges = [
    {
        "operationType": "create",
        "ns": {"db": dbName, "coll": bucketsCollName},
        "operationDescription": {
            "validator": {
                "$jsonSchema": {
                    "bsonType": "object",
                    "required": ["_id", "control", "data"],
                    "properties": {
                        "_id": {"bsonType": "objectId"},
                        "control": {
                            "bsonType": "object",
                            "required": ["version", "min", "max"],
                            "properties": {
                                "version": {"bsonType": "number"},
                                "min": {
                                    "bsonType": "object",
                                    "required": ["ts"],
                                    "properties": {"ts": {"bsonType": "date"}}
                                },
                                "max": {
                                    "bsonType": "object",
                                    "required": ["ts"],
                                    "properties": {"ts": {"bsonType": "date"}}
                                },
                                "closed": {"bsonType": "bool"},
                                "count": {"bsonType": "number", "minimum": 1}
                            },
                            "additionalProperties": false
                        },
                        "data": {"bsonType": "object"},
                        "meta": {

                        }
                    },
                    "additionalProperties": false
                }
            },
            "clusteredIndex": true,
            "timeseries": {
                "timeField": "ts",
                "metaField": "meta",
                "granularity": "seconds",
                "bucketMaxSpanSeconds": 3600
            }
        }
    },
    {
        // Only seen if time series scalability improvements enabled
        "operationType": "createIndexes",
        "ns": {"db": dbName, "coll": bucketsCollName},
        "operationDescription": {
            "indexes": [{
                "v": 2,
                "name": "meta_1_ts_1",
                "key": {"meta": 1, "control.min.ts": 1, "control.max.ts": 1}
            }]
        }
    },
    {
        "operationType": "create",
        "ns": {"db": dbName, "coll": collName},
        "operationDescription": {
            "viewOn": bucketsCollName,
            "pipeline": [{
                "$_internalUnpackBucket":
                    {"timeField": "ts", "metaField": "meta", "bucketMaxSpanSeconds": 3600}
            }]
        }
    },
    {
        "operationType": "createIndexes",
        "ns": {"db": dbName, "coll": bucketsCollName},
        "operationDescription": {
            "indexes": [{
                "v": 2,
                "key": {"control.min.ts": 1, "control.max.ts": 1, "meta.b": 1},
                "name": "dropMe"
            }]
        }
    },
    {
        "operationType": "insert",
        "fullDocument": {
            "control": {
                "version": 1,
                "min": {"_id": 1, "ts": ISODate("1970-01-01T00:00:00Z")},
                "max": {"_id": 1, "ts": ISODate("1970-01-01T00:00:01Z")},
                "closed": false  // Only seen if time series scalability improvements enabled
            },
            "meta": {"a": 1},
            "data": {"_id": {"0": 1}, "ts": {"0": ISODate("1970-01-01T00:00:01Z")}}
        },
        "ns": {"db": dbName, "coll": bucketsCollName}
    },
    {
        "operationType": "update",
        "ns": {"db": dbName, "coll": bucketsCollName},
        "updateDescription": {
            "updatedFields": {"data._id.1": 1, "data.ts.1": ISODate("1970-01-01T00:00:01Z")},
            "removedFields": [],
            "truncatedArrays": [],
            "disambiguatedPaths":
                {"data._id.1": ["data", "_id", "1"], "data.ts.1": ["data", "ts", "1"]}
        }
    },
    {"operationType": "delete", "ns": {"db": dbName, "coll": bucketsCollName}},
    {
        "operationType": "modify",
        "ns": {"db": dbName, "coll": collName},
        "operationDescription": {
            "viewOn": "system.buckets.timeseries",
            "pipeline": [{
                "$_internalUnpackBucket":
                    {"timeField": "ts", "metaField": "meta", "bucketMaxSpanSeconds": 2592000}
            }]
        }
    },
    {
        "operationType": "modify",
        "ns": {"db": dbName, "coll": bucketsCollName},
        "operationDescription": {"timeseries": {"granularity": "hours"}},
        "stateBeforeChange": {
            "collectionOptions": {
                "validator": {
                    "$jsonSchema": {
                        "bsonType": "object",
                        "required": ["_id", "control", "data"],
                        "properties": {
                            "_id": {"bsonType": "objectId"},
                            "control": {
                                "bsonType": "object",
                                "required": ["version", "min", "max"],
                                "properties": {
                                    "version": {"bsonType": "number"},
                                    "min": {
                                        "bsonType": "object",
                                        "required": ["ts"],
                                        "properties": {"ts": {"bsonType": "date"}}
                                    },
                                    "max": {
                                        "bsonType": "object",
                                        "required": ["ts"],
                                        "properties": {"ts": {"bsonType": "date"}}
                                    },
                                    "closed": {"bsonType": "bool"},
                                    "count": {"bsonType": "number", "minimum": 1}
                                },
                                "additionalProperties": false
                            },
                            "data": {"bsonType": "object"},
                            "meta": {

                            }
                        },
                        "additionalProperties": false
                    }
                },
                "clusteredIndex": true,
                "timeseries": {
                    "timeField": "ts",
                    "metaField": "meta",
                    "granularity": "seconds",
                    "bucketMaxSpanSeconds": 3600
                }
            }
        }
    },
    {
        "operationType": "modify",
        "ns": {"db": dbName, "coll": bucketsCollName},
        "operationDescription": {"expireAfterSeconds": NumberLong(1)},
        "stateBeforeChange": {
            "collectionOptions": {
                "validator": {
                    "$jsonSchema": {
                        "bsonType": "object",
                        "required": ["_id", "control", "data"],
                        "properties": {
                            "_id": {"bsonType": "objectId"},
                            "control": {
                                "bsonType": "object",
                                "required": ["version", "min", "max"],
                                "properties": {
                                    "version": {"bsonType": "number"},
                                    "min": {
                                        "bsonType": "object",
                                        "required": ["ts"],
                                        "properties": {"ts": {"bsonType": "date"}}
                                    },
                                    "max": {
                                        "bsonType": "object",
                                        "required": ["ts"],
                                        "properties": {"ts": {"bsonType": "date"}}
                                    },
                                    "closed": {"bsonType": "bool"},
                                    "count": {"bsonType": "number", "minimum": 1}
                                },
                                "additionalProperties": false
                            },
                            "data": {"bsonType": "object"},
                            "meta": {

                            }
                        },
                        "additionalProperties": false
                    }
                },
                "clusteredIndex": true,
                "timeseries": {
                    "timeField": "ts",
                    "metaField": "meta",
                    "granularity": "hours",
                    "bucketMaxSpanSeconds": 2592000
                }
            }
        }
    },
    {
        "operationType": "dropIndexes",
        "ns": {"db": dbName, "coll": bucketsCollName},
        "operationDescription": {
            "indexes": [{
                "v": 2,
                "key": {"control.min.ts": 1, "control.max.ts": 1, "meta.b": 1},
                "name": "dropMe"
            }]
        }
    },
    {"operationType": "drop", "ns": {"db": dbName, "coll": collName}},
    {"operationType": "drop", "ns": {"db": dbName, "coll": bucketsCollName}}
];

if (!FeatureFlagUtil.isEnabled(db, "TimeseriesScalabilityImprovements")) {
    // Under this feature flag, buckets are created with the closed field set to false.
    // Remove closed field if the feature flag is not enabled.
    delete expectedChanges[4].fullDocument.control.closed;
    // Remove implicitly create index
    expectedChanges = [expectedChanges[0], ...expectedChanges.slice(2)];
}

cst.assertNextChangesEqual({cursor: curWithEvents, expectedChanges});

const assertNoMoreBucketsEvents = (cur) => {
    assert.soon(() => {
        if (!cur.hasNext())
            return true;
        let event = cur.next();
        assert(event.ns.coll !== bucketsCollName,
               "shouldn't have seen without showSystemEvents" + tojson(event));
        return !cur.hasNext();
    });
};

// After all the expected events we should have no more events on the system.buckets ns.
let curWithEventsNormal = new DBCommandCursor(testDB, {ok: 1, cursor: curWithEvents});
assertNoMoreBucketsEvents(curWithEventsNormal);

// No events cursor should have no system.buckets events.
assertNoMoreBucketsEvents(curNoEvents);
}());
