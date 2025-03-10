/**
 *    Copyright (C) 2022-present MongoDB, Inc.
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

#include "mongo/crypto/asymmetric_crypto.h"

#include <memory>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/ossl_typ.h>
#include <openssl/rsa.h>

#include "mongo/base/status.h"
#include "mongo/crypto/rsa_public_key.h"
#include "mongo/util/assert_util.h"
#include "mongo/util/net/ssl_manager.h"

#if OPENSSL_VERSION_NUMBER < 0x10100000L || \
    (defined(LIBRESSL_VERSION_NUMBER) && LIBRESSL_VERSION_NUMBER < 0x2070000fL)
namespace {
// Copies of OpenSSL 1.1.0 and later define new EVP digest routines. We must
// polyfill used definitions to interact with older OpenSSL versions.
EVP_MD_CTX* EVP_MD_CTX_new() {
    return EVP_MD_CTX_create();
}

void EVP_MD_CTX_free(EVP_MD_CTX* ctx) {
    EVP_MD_CTX_destroy(ctx);
}

}  // namespace
#endif

namespace mongo::crypto {
namespace {

using UniqueRSA = std::unique_ptr<RSA, OpenSSLDeleter<decltype(RSA_free), RSA_free>>;
using UniqueEVPPKey =
    std::unique_ptr<EVP_PKEY, OpenSSLDeleter<decltype(EVP_PKEY_free), EVP_PKEY_free>>;
using UniqueBIGNUM = std::unique_ptr<BIGNUM, OpenSSLDeleter<decltype(BN_free), BN_free>>;

class RSAKeySignatureVerifierOpenSSL : public RSAKeySignatureVerifier {
public:
    RSAKeySignatureVerifierOpenSSL(const RsaPublicKey& pubKey, HashingAlgorithm hashAlg)
        : _verificationCtx(EVP_MD_CTX_new()) {
#if OPENSSL_VERSION_NUMBER > 0x10100000L || \
    (defined(LIBRESSL_VERSION_NUMBER) && LIBRESSL_VERSION_NUMBER > 0x2070000fL)
        const auto* pubKeyNData = pubKey.getN().data<unsigned char>();
        UniqueBIGNUM n(BN_bin2bn(pubKeyNData, pubKey.getN().length(), nullptr));
        uassertOpenSSL("Failed creating modulus", n.get() != nullptr);

        const auto* pubKeyEData = pubKey.getE().data<unsigned char>();
        UniqueBIGNUM e(BN_bin2bn(pubKeyEData, pubKey.getE().length(), nullptr));
        uassertOpenSSL("Failed creating exponent", e.get() != nullptr);

        UniqueRSA rsa(RSA_new());
        uassertOpenSSL("Failed creating RSAKey", rsa.get() != nullptr);
        uassertOpenSSL("RSA key setup failed",
                       RSA_set0_key(rsa.get(), n.get(), e.get(), nullptr) == 1);
        n.release();  // Now owned by rsa
        e.release();  // Now owned by rsa

        UniqueEVPPKey evpKey(EVP_PKEY_new());
        uassertOpenSSL("Failed creating EVP_PKey", evpKey.get() != nullptr);
        uassertOpenSSL("EVP_PKEY assignment failed",
                       EVP_PKEY_assign_RSA(evpKey.get(), rsa.get()) == 1);
        rsa.release();  // Now owned by evpKey

        uassert(6755199, "Unknown hashing algorithm", hashAlg == HashingAlgorithm::SHA256);
        uassertOpenSSL("DigestVerifyInit failed",
                       EVP_DigestVerifyInit(
                           _verificationCtx.get(), nullptr, EVP_sha256(), nullptr, evpKey.get()) ==
                           1);
#endif
    }

    Status verifySignature(ConstDataRange msg, ConstDataRange signature) final {
#if OPENSSL_VERSION_NUMBER > 0x10100000L || \
    (defined(LIBRESSL_VERSION_NUMBER) && LIBRESSL_VERSION_NUMBER > 0x2070000fL)

        uassertOpenSSL("DigestVerifyUpdate failed",
                       EVP_DigestVerifyUpdate(
                           _verificationCtx.get(), msg.data<std::uint8_t>(), msg.length()) == 1);

        int verifyRes = EVP_DigestVerifyFinal(
            _verificationCtx.get(), signature.data<std::uint8_t>(), signature.length());
        if (verifyRes == 0) {
            return {ErrorCodes::InvalidSignature, "OpenSSL: Signature is invalid"};
        } else if (verifyRes != 1) {
            return {ErrorCodes::UnknownError,
                    SSLManagerInterface::getSSLErrorMessage(ERR_get_error())};
        }
        return Status::OK();
#endif
        return {ErrorCodes::OperationFailed, "Signature Verification Not Available"};
    }

private:
    std::unique_ptr<EVP_MD_CTX, OpenSSLDeleter<decltype(EVP_MD_CTX_free), ::EVP_MD_CTX_free>>
        _verificationCtx;

    static void uassertOpenSSL(StringData context, bool success) {
        uassert(ErrorCodes::OperationFailed,
                str::stream() << context << ": "
                              << SSLManagerInterface::getSSLErrorMessage(ERR_get_error()),
                success);
    }
};
}  // namespace

StatusWith<std::unique_ptr<RSAKeySignatureVerifier>> RSAKeySignatureVerifier::create(
    const RsaPublicKey& pubKey, HashingAlgorithm hashAlg) try {
    return std::make_unique<RSAKeySignatureVerifierOpenSSL>(pubKey, hashAlg);
} catch (const DBException& e) {
    return e.toStatus();
}
}  // namespace mongo::crypto
