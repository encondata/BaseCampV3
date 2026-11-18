package com.serversherpa.kiosk.data.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.provider.Settings
import java.io.File

/** The system side of an update: install permission, archive check and the installer hand-off. */
interface ApkInstall {
    fun canRequestInstalls(): Boolean
    fun openInstallPermissionSettings()             // ACTION_MANAGE_UNKNOWN_APP_SOURCES, data package:<pkg>, NEW_TASK
    /** null when the file is packageName at build; otherwise the notice to show. */
    fun checkArchive(file: File, packageName: String, build: Long, versionName: String): String?
    fun install(file: File)                          // PackageInstaller session; commit → UpdateInstallReceiver
    fun launchPendingConfirm(): Boolean              // starts InstallEvents.pendingConfirm, clears it
    /** Abandons this app's leftover installer sessions; never throws. */
    fun abandonSessions()
}

class AndroidApkInstall(context: Context) : ApkInstall {
    private val context = context.applicationContext
    private val pkg = this.context.packageName

    override fun canRequestInstalls(): Boolean = context.packageManager.canRequestPackageInstalls()

    override fun openInstallPermissionSettings() {
        context.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$pkg"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    override fun checkArchive(file: File, packageName: String, build: Long, versionName: String): String? {
        val info = context.packageManager.getPackageArchiveInfo(file.path, 0)
            ?: return "The downloaded file isn't an app this phone can install."
        if (info.packageName != packageName || info.longVersionCode != build) {
            return "The downloaded file isn't ServerSherpa Kiosk $versionName."
        }
        return null
    }

    override fun install(file: File) {
        abandonSessions()   // one update at a time: an earlier session is stale
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(pkg)
            setSize(file.length())
        }
        val sessionId = installer.createSession(params)
        try {
            installer.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val status = Intent(context, UpdateInstallReceiver::class.java).setPackage(pkg)
                val pending = PendingIntent.getBroadcast(
                    context, sessionId, status,
                    // Mutable: the system fills in the status extras.
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                session.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(sessionId) }
            throw e
        }
    }

    override fun abandonSessions() {
        val installer = runCatching { context.packageManager.packageInstaller }.getOrNull() ?: return
        val mine = runCatching { installer.mySessions }.getOrDefault(emptyList())
        for (s in mine) {
            if (s.appPackageName == pkg) runCatching { installer.abandonSession(s.sessionId) }
        }
    }

    override fun launchPendingConfirm(): Boolean {
        val confirm = InstallEvents.takePendingConfirm() ?: return false
        context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return true
    }
}
