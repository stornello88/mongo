/**
 *    Copyright (C) 2018-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#include "mongo/platform/basic.h"

#include <string>
#include <vector>

#include "mongo/bson/json.h"
#include "mongo/db/catalog_raii.h"
#include "mongo/db/concurrency/exception_util.h"
#include "mongo/db/curop.h"
#include "mongo/db/namespace_string.h"
#include "mongo/db/operation_context.h"
#include "mongo/db/repl/replication_coordinator_mock.h"
#include "mongo/db/s/config/config_server_test_fixture.h"
#include "mongo/db/s/config/sharding_catalog_manager.h"
#include "mongo/s/catalog/config_server_version.h"
#include "mongo/s/catalog/sharding_catalog_client.h"
#include "mongo/s/catalog/type_chunk.h"
#include "mongo/s/catalog/type_config_version.h"
#include "mongo/s/catalog/type_shard.h"
#include "mongo/s/catalog/type_tags.h"
#include "mongo/s/client/shard.h"
#include "mongo/util/scopeguard.h"

namespace mongo {
namespace {

using unittest::assertGet;

class ConfigInitializationTest : public ConfigServerTestFixture {
protected:
    /*
     * Initializes the sharding state and locks both the config db and rstl.
     */
    void setUp() override {
        // Prevent DistLockManager from writing to lockpings collection before we create the
        // indexes.
        // TODO (SERVER-64987): Remove lock acquisition.
        _autoDb = setUpAndLockConfigDb();
    }

    void tearDown() override {
        _autoDb = {};
        ConfigServerTestFixture::tearDown();
    }

    std::unique_ptr<AutoGetDb> _autoDb;
};

TEST_F(ConfigInitializationTest, UpgradeNotNeeded) {
    VersionType version;
    version.setClusterId(OID::gen());
    version.setCurrentVersion(CURRENT_CONFIG_VERSION);
    version.setMinCompatibleVersion(MIN_COMPATIBLE_CONFIG_VERSION);
    ASSERT_OK(
        insertToConfigCollection(operationContext(), VersionType::ConfigNS, version.toBSON()));

    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->initializeConfigDatabaseIfNeeded(operationContext()));

    _autoDb.reset();
    auto versionDoc =
        assertGet(findOneOnConfigCollection(operationContext(), VersionType::ConfigNS, BSONObj()));

    VersionType foundVersion = assertGet(VersionType::fromBSON(versionDoc));

    ASSERT_EQUALS(version.getClusterId(), foundVersion.getClusterId());
    ASSERT_EQUALS(version.getCurrentVersion(), foundVersion.getCurrentVersion());
    ASSERT_EQUALS(version.getMinCompatibleVersion(), foundVersion.getMinCompatibleVersion());
}

TEST_F(ConfigInitializationTest, InitIncompatibleVersion) {
    VersionType version;
    version.setClusterId(OID::gen());
    version.setCurrentVersion(MIN_COMPATIBLE_CONFIG_VERSION - 1);
    version.setMinCompatibleVersion(MIN_COMPATIBLE_CONFIG_VERSION - 2);
    ASSERT_OK(
        insertToConfigCollection(operationContext(), VersionType::ConfigNS, version.toBSON()));

    ASSERT_EQ(ErrorCodes::IncompatibleShardingConfigVersion,
              ShardingCatalogManager::get(operationContext())
                  ->initializeConfigDatabaseIfNeeded(operationContext()));

    _autoDb.reset();
    auto versionDoc =
        assertGet(findOneOnConfigCollection(operationContext(), VersionType::ConfigNS, BSONObj()));

    VersionType foundVersion = assertGet(VersionType::fromBSON(versionDoc));

    ASSERT_EQUALS(version.getClusterId(), foundVersion.getClusterId());
    ASSERT_EQUALS(version.getCurrentVersion(), foundVersion.getCurrentVersion());
    ASSERT_EQUALS(version.getMinCompatibleVersion(), foundVersion.getMinCompatibleVersion());
}

TEST_F(ConfigInitializationTest, InitClusterMultipleVersionDocs) {
    VersionType version;
    version.setClusterId(OID::gen());
    version.setCurrentVersion(MIN_COMPATIBLE_CONFIG_VERSION - 2);
    version.setMinCompatibleVersion(MIN_COMPATIBLE_CONFIG_VERSION - 3);
    ASSERT_OK(
        insertToConfigCollection(operationContext(), VersionType::ConfigNS, version.toBSON()));

    ASSERT_OK(insertToConfigCollection(operationContext(),
                                       VersionType::ConfigNS,
                                       BSON("_id"
                                            << "a second document")));

    ASSERT_EQ(ErrorCodes::TooManyMatchingDocuments,
              ShardingCatalogManager::get(operationContext())
                  ->initializeConfigDatabaseIfNeeded(operationContext()));
}

TEST_F(ConfigInitializationTest, InitInvalidConfigVersionDoc) {
    BSONObj versionDoc(fromjson(R"({
                    _id: 1,
                    minCompatibleVersion: "should be numeric",
                    currentVersion: 7,
                    clusterId: ObjectId("55919cc6dbe86ce7ac056427")
                })"));
    ASSERT_OK(insertToConfigCollection(operationContext(), VersionType::ConfigNS, versionDoc));

    ASSERT_EQ(ErrorCodes::TypeMismatch,
              ShardingCatalogManager::get(operationContext())
                  ->initializeConfigDatabaseIfNeeded(operationContext()));
}


TEST_F(ConfigInitializationTest, InitNoVersionDocEmptyConfig) {
    // Make sure there is no existing document
    ASSERT_EQUALS(ErrorCodes::NoMatchingDocument,
                  findOneOnConfigCollection(operationContext(), VersionType::ConfigNS, BSONObj()));

    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->initializeConfigDatabaseIfNeeded(operationContext()));

    _autoDb.reset();
    auto versionDoc =
        assertGet(findOneOnConfigCollection(operationContext(), VersionType::ConfigNS, BSONObj()));

    VersionType foundVersion = assertGet(VersionType::fromBSON(versionDoc));

    ASSERT_TRUE(foundVersion.getClusterId().isSet());
    ASSERT_EQUALS(CURRENT_CONFIG_VERSION, foundVersion.getCurrentVersion());
    ASSERT_EQUALS(MIN_COMPATIBLE_CONFIG_VERSION, foundVersion.getMinCompatibleVersion());
}

TEST_F(ConfigInitializationTest, InitVersionTooHigh) {
    VersionType version;
    version.setClusterId(OID::gen());
    version.setCurrentVersion(10000);
    version.setMinCompatibleVersion(10000);
    ASSERT_OK(
        insertToConfigCollection(operationContext(), VersionType::ConfigNS, version.toBSON()));

    ASSERT_EQ(ErrorCodes::IncompatibleShardingConfigVersion,
              ShardingCatalogManager::get(operationContext())
                  ->initializeConfigDatabaseIfNeeded(operationContext()));
}

TEST_F(ConfigInitializationTest, OnlyRunsOnce) {
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->initializeConfigDatabaseIfNeeded(operationContext()));

    _autoDb.reset();
    auto versionDoc =
        assertGet(findOneOnConfigCollection(operationContext(), VersionType::ConfigNS, BSONObj()));

    VersionType foundVersion = assertGet(VersionType::fromBSON(versionDoc));

    ASSERT_TRUE(foundVersion.getClusterId().isSet());
    ASSERT_EQUALS(CURRENT_CONFIG_VERSION, foundVersion.getCurrentVersion());
    ASSERT_EQUALS(MIN_COMPATIBLE_CONFIG_VERSION, foundVersion.getMinCompatibleVersion());

    ASSERT_EQUALS(ErrorCodes::AlreadyInitialized,
                  ShardingCatalogManager::get(operationContext())
                      ->initializeConfigDatabaseIfNeeded(operationContext()));
}

TEST_F(ConfigInitializationTest, ReRunsIfDocRolledBackThenReElected) {
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->initializeConfigDatabaseIfNeeded(operationContext()));

    _autoDb.reset();
    auto versionDoc =
        assertGet(findOneOnConfigCollection(operationContext(), VersionType::ConfigNS, BSONObj()));

    VersionType foundVersion = assertGet(VersionType::fromBSON(versionDoc));

    ASSERT_TRUE(foundVersion.getClusterId().isSet());
    ASSERT_EQUALS(CURRENT_CONFIG_VERSION, foundVersion.getCurrentVersion());
    ASSERT_EQUALS(MIN_COMPATIBLE_CONFIG_VERSION, foundVersion.getMinCompatibleVersion());

    // Now remove the version document and re-run initializeConfigDatabaseIfNeeded().
    {
        // Mirror what happens if the config.version document is rolled back.
        ON_BLOCK_EXIT([&] {
            replicationCoordinator()->setFollowerMode(repl::MemberState::RS_PRIMARY).ignore();
        });
        ASSERT_OK(replicationCoordinator()->setFollowerMode(repl::MemberState::RS_ROLLBACK));
        auto opCtx = operationContext();
        repl::UnreplicatedWritesBlock uwb(opCtx);
        auto nss = VersionType::ConfigNS;
        writeConflictRetry(opCtx, "removeConfigDocuments", nss.ns(), [&] {
            AutoGetCollection coll(opCtx, nss, MODE_IX);
            ASSERT_TRUE(coll);
            auto cursor = coll->getCursor(opCtx);
            std::vector<RecordId> recordIds;
            while (auto recordId = cursor->next()) {
                recordIds.push_back(recordId->id);
            }
            mongo::WriteUnitOfWork wuow(opCtx);
            for (auto recordId : recordIds) {
                coll->deleteDocument(opCtx, kUninitializedStmtId, recordId, nullptr);
            }
            wuow.commit();
            ASSERT_EQUALS(0UL, coll->numRecords(opCtx));
        });
    }

    // Verify the document was actually removed.
    ASSERT_EQUALS(ErrorCodes::NoMatchingDocument,
                  findOneOnConfigCollection(operationContext(), VersionType::ConfigNS, BSONObj()));

    // Re-create the config.version document.
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->initializeConfigDatabaseIfNeeded(operationContext()));

    auto newVersionDoc =
        assertGet(findOneOnConfigCollection(operationContext(), VersionType::ConfigNS, BSONObj()));

    VersionType newFoundVersion = assertGet(VersionType::fromBSON(newVersionDoc));

    ASSERT_TRUE(newFoundVersion.getClusterId().isSet());
    ASSERT_NOT_EQUALS(newFoundVersion.getClusterId(), foundVersion.getClusterId());
    ASSERT_EQUALS(CURRENT_CONFIG_VERSION, newFoundVersion.getCurrentVersion());
    ASSERT_EQUALS(MIN_COMPATIBLE_CONFIG_VERSION, newFoundVersion.getMinCompatibleVersion());
}

TEST_F(ConfigInitializationTest, BuildsNecessaryIndexes) {
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->initializeConfigDatabaseIfNeeded(operationContext()));

    std::vector<BSONObj> expectedChunksIndexes = std::vector<BSONObj>{
        BSON("v" << 2 << "key" << BSON("_id" << 1) << "name"
                 << "_id_"),
        BSON("v" << 2 << "key" << BSON("uuid" << 1 << "min" << 1) << "name"
                 << "uuid_1_min_1"
                 << "unique" << true),
        BSON("v" << 2 << "key" << BSON("uuid" << 1 << "shard" << 1 << "min" << 1) << "name"
                 << "uuid_1_shard_1_min_1"
                 << "unique" << true),
        BSON("v" << 2 << "key" << BSON("uuid" << 1 << "lastmod" << 1) << "name"
                 << "uuid_1_lastmod_1"
                 << "unique" << true)};

    auto expectedShardsIndexes = std::vector<BSONObj>{
        BSON("v" << 2 << "key" << BSON("_id" << 1) << "name"
                 << "_id_"),
        BSON("v" << 2 << "unique" << true << "key" << BSON("host" << 1) << "name"
                 << "host_1")};
    auto expectedTagsIndexes = std::vector<BSONObj>{
        BSON("v" << 2 << "key" << BSON("_id" << 1) << "name"
                 << "_id_"),
        BSON("v" << 2 << "unique" << true << "key" << BSON("ns" << 1 << "min" << 1) << "name"
                 << "ns_1_min_1"),
        BSON("v" << 2 << "key" << BSON("ns" << 1 << "tag" << 1) << "name"
                 << "ns_1_tag_1")};

    auto foundChunksIndexes = assertGet(getIndexes(operationContext(), ChunkType::ConfigNS));
    assertBSONObjsSame(expectedChunksIndexes, foundChunksIndexes);

    auto foundShardsIndexes =
        assertGet(getIndexes(operationContext(), NamespaceString::kConfigsvrShardsNamespace));
    assertBSONObjsSame(expectedShardsIndexes, foundShardsIndexes);

    auto foundTagsIndexes = assertGet(getIndexes(operationContext(), TagsType::ConfigNS));
    assertBSONObjsSame(expectedTagsIndexes, foundTagsIndexes);
}

}  // unnamed namespace
}  // namespace mongo
