package com.serversherpa.kiosk.data.update

import android.content.Context
import android.content.pm.PackageManager
import java.security.MessageDigest

/** SHA-256 of this app's signing certificate; the Devices site compares it with the one it holds. */
object SigningDigest {
    fun hex(certDer: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(certDer).joinToString("") { "%02x".format(it) }

    /** The first signer's digest, or "" when the package info can't be read. */
    fun of(context: Context): String = try {
        val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        info.signingInfo?.apkContentsSigners?.firstOrNull()?.let { hex(it.toByteArray()) } ?: ""
    } catch (_: Exception) {
        ""
    }
}
