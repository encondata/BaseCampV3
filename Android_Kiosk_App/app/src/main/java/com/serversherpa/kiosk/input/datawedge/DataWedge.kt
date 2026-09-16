package com.serversherpa.kiosk.input.datawedge

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource

/**
 * Zebra DataWedge: on a Zebra device the built-in scan engine is driven
 * by DataWedge, which we configure (once, at startup) to broadcast every
 * scan to SCAN_ACTION and to stop typing it as keystrokes. Nothing here
 * runs on a device without the DataWedge package.
 */
object DataWedge {
    const val PACKAGE = "com.symbol.datawedge"
    const val PROFILE = "ServerSherpaKiosk"
    const val SCAN_ACTION = "com.serversherpa.kiosk.SCAN"
    private const val API_ACTION = "com.symbol.datawedge.api.ACTION"
    private const val EXTRA_DATA = "com.symbol.datawedge.data_string"
    private const val EXTRA_LABEL = "com.symbol.datawedge.label_type"

    fun isPresent(context: Context): Boolean = try {
        context.packageManager.getPackageInfo(PACKAGE, 0); true
    } catch (e: PackageManager.NameNotFoundException) { false }

    /** The SET_CONFIG bundle: profile bound to our package, barcode in, intent out, keystrokes off. */
    fun profileConfig(packageName: String): Bundle {
        val app = Bundle().apply { putString("PACKAGE_NAME", packageName); putStringArray("ACTIVITY_LIST", arrayOf("*")) }
        val barcode = Bundle().apply {
            putString("PLUGIN_NAME", "BARCODE"); putString("RESET_CONFIG", "true")
            putBundle("PARAM_LIST", Bundle().apply { putString("scanner_input_enabled", "true"); putString("scanner_selection", "auto") })
        }
        val intent = Bundle().apply {
            putString("PLUGIN_NAME", "INTENT"); putString("RESET_CONFIG", "true")
            putBundle("PARAM_LIST", Bundle().apply {
                putString("intent_output_enabled", "true"); putString("intent_action", SCAN_ACTION)
                putString("intent_category", Intent.CATEGORY_DEFAULT); putString("intent_delivery", "2")
            })
        }
        val keystroke = Bundle().apply {
            putString("PLUGIN_NAME", "KEYSTROKE"); putString("RESET_CONFIG", "true")
            putBundle("PARAM_LIST", Bundle().apply { putString("keystroke_output_enabled", "false") })
        }
        return Bundle().apply {
            putString("PROFILE_NAME", PROFILE); putString("PROFILE_ENABLED", "true"); putString("CONFIG_MODE", "CREATE_IF_NOT_EXIST")
            putParcelableArray("APP_LIST", arrayOf(app))
            putParcelableArrayList("PLUGIN_CONFIG", arrayListOf(barcode, intent, keystroke))
        }
    }

    fun configure(context: Context) {
        if (!isPresent(context)) return
        context.sendBroadcast(Intent(API_ACTION).setPackage(PACKAGE).putExtra("com.symbol.datawedge.api.SET_CONFIG", profileConfig(context.packageName)))
    }

    /** Fires the scan engine as if the trigger were pressed. */
    fun softScan(context: Context, start: Boolean) {
        if (!isPresent(context)) return
        context.sendBroadcast(Intent(API_ACTION).setPackage(PACKAGE)
            .putExtra("com.symbol.datawedge.api.SOFT_SCAN_TRIGGER", if (start) "START_SCANNING" else "STOP_SCANNING"))
    }

    fun parseScan(intent: Intent): ScanEvent? {
        if (intent.action != SCAN_ACTION) return null
        val value = intent.getStringExtra(EXTRA_DATA)?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val label = intent.getStringExtra(EXTRA_LABEL)?.removePrefix("LABEL-TYPE-")
        return ScanEvent(value, ScanSource.DATAWEDGE, label)
    }
}
