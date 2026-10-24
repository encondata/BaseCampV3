package com.serversherpa.kiosk.data.auth

import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** A software P-256 key standing in for the Keystore one: real signatures, so a test can verify
 *  what was signed. [invalidated] plays Android dropping the key (a new fingerprint enrolled). */
class FakeBiometricKeys(var readiness: BiometricReadiness = BiometricReadiness.READY) : BiometricKeys {
    var pair: KeyPair? = null
    var invalidated = false
    /** The attestation challenges [create] was given. */
    val challenges = ArrayList<ByteArray>()
    var chain: List<ByteArray> = listOf(byteArrayOf(1, 2, 3), byteArrayOf(4, 5, 6, 7))
    var createError: Exception? = null
    /** Thrown by [signer]: the Keystore failing this time (a ProviderException, say). */
    var signerError: Exception? = null
    /** Thrown by [canUse]. */
    var canUseError: Exception? = null
    var deletes = 0
    val hasKey: Boolean get() = pair != null

    override fun canUse(): BiometricReadiness { canUseError?.let { throw it }; return readiness }

    override fun create(nonce: ByteArray): List<ByteArray> {
        createError?.let { throw it }
        challenges += nonce
        pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        invalidated = false
        return chain
    }

    override fun signer(): Signature? {
        signerError?.let { throw it }
        val p = pair ?: return null
        if (invalidated) return null
        return Signature.getInstance("SHA256withECDSA").apply { initSign(p.private) }
    }

    override fun delete() { deletes++; pair = null; invalidated = false }
}
