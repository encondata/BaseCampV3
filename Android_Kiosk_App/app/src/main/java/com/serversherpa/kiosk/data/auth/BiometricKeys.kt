package com.serversherpa.kiosk.data.auth

import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.biometric.BiometricManager
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.UnrecoverableKeyException
import java.security.spec.ECGenParameterSpec

/** Whether this phone can hold a biometric sign-in key right now. */
enum class BiometricReadiness { READY, NO_HARDWARE, NONE_ENROLLED, NO_SECURE_LOCK }

/**
 * The phone's one biometric sign-in key. Every member is blocking Keystore work: call it off the
 * main thread. [BiometricSignIn] holds the rules; this is only the key.
 */
interface BiometricKeys {
    fun canUse(): BiometricReadiness

    /** Makes a new key (replacing any old one) whose attestation challenge is [nonce] (the
     *  SHA-256 of the server's enroll nonce), and returns its attestation chain, leaf first, DER.
     *  Throws when the Keystore can't make one. */
    fun create(nonce: ByteArray): List<ByteArray>

    /** A `SHA256withECDSA` Signature initialized with the key, for the biometric prompt's
     *  CryptoObject; null when there is no key, or Android invalidated it (a new fingerprint
     *  enrolled, the screen lock removed). */
    fun signer(): Signature?

    fun delete()
}

/** [BiometricKeys] on AndroidKeyStore. Thin on purpose: the device pass covers it. */
class AndroidBiometricKeys(private val context: Context) : BiometricKeys {

    override fun canUse(): BiometricReadiness {
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        if (keyguard?.isDeviceSecure != true) return BiometricReadiness.NO_SECURE_LOCK
        return when (BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)) {
            BiometricManager.BIOMETRIC_SUCCESS -> BiometricReadiness.READY
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricReadiness.NONE_ENROLLED
            else -> BiometricReadiness.NO_HARDWARE
        }
    }

    override fun create(nonce: ByteArray): List<ByteArray> {
        delete()
        val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        try {
            generate(nonce, strongBox)
        } catch (e: StrongBoxUnavailableException) {
            generate(nonce, strongBox = false)
        }
        val chain = keyStore().getCertificateChain(ALIAS) ?: error("no attestation chain")
        return chain.map { it.encoded }
    }

    private fun generate(nonce: ByteArray, strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            // Exactly a strong biometric, every use: never DEVICE_CREDENTIAL (the server checks).
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            .setInvalidatedByBiometricEnrollment(true)
            .setAttestationChallenge(nonce)
            .setIsStrongBoxBacked(strongBox)
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).apply { initialize(spec) }.generateKeyPair()
    }

    override fun signer(): Signature? {
        val ks = keyStore()
        val key = try { ks.getKey(ALIAS, null) as? PrivateKey } catch (e: UnrecoverableKeyException) { null } ?: return null
        if (ks.getCertificate(ALIAS) == null) return null
        return try {
            Signature.getInstance(SIGNATURE).apply { initSign(key) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            null
        }
    }

    override fun delete() {
        val ks = keyStore()
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    companion object {
        const val ALIAS = "ss_biometric_signin"
        const val KEYSTORE = "AndroidKeyStore"
        const val SIGNATURE = "SHA256withECDSA"
    }
}
