package com.serversherpa.kiosk.data.update

import com.serversherpa.kiosk.BuildConfig
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.update.NO_DEVICES_HOST
import com.serversherpa.kiosk.core.update.UpdateOffer
import com.serversherpa.kiosk.core.update.checkFailureMessage
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.File

/** The direct flavor's update check: the Devices site, the APK downloader and the system installer. */
fun createAppUpdates(deps: UpdateDeps): AppUpdates {
    val client = DevicesUpdateClient(deps.client, deps.session, deps.apiUrl)
    val downloader = ApkDownloader(deps.client, File(deps.app.filesDir, "updates"))
    val packageName = deps.app.packageName
    val digest by lazy { SigningDigest.of(deps.app) }
    val checker = devicesChecker(client, packageName, BuildConfig.VERSION_CODE.toLong()) { digest }
    val source = object : ApkSource {
        override suspend fun fetch(offer: UpdateOffer, onProgress: (Float?) -> Unit): File {
            val base = client.devicesBase() ?: throw UpdateError(NO_DEVICES_HOST)
            return downloader.download(offer, base, onProgress)
        }

        override fun clear() = downloader.clear()
    }
    return DirectAppUpdates(
        checker, source, AndroidApkInstall(deps.app), packageName,
        deps.authState, deps.foreground, deps.scope,
    )
}

/** Asks [client] about this build; a failed request becomes the UpdateError Settings shows. */
internal fun devicesChecker(
    client: DevicesUpdateClient,
    packageName: String,
    versionCode: Long,
    digest: () -> String,
) = UpdateChecker {
    try {
        client.check(packageName, versionCode, digest())
    } catch (e: ApiError) {
        val host = client.devicesBase()?.toHttpUrlOrNull()?.host ?: "the Devices site"
        throw UpdateError(checkFailureMessage(e, host))
    }
}
