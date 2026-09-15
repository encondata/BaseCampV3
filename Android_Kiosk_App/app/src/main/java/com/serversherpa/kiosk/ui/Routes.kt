package com.serversherpa.kiosk.ui

object Routes {
    const val LOGIN = "login"
    const val HOME = "home"
    const val SETUP = "setup"
    const val SETTINGS = "settings?tab={tab}"
    const val SCAN = "scan"
    const val ENROLL = "enroll"
    const val TIMECLOCK = "timeclock"
    const val CONTAINERS = "containers"
    const val TRUCKS = "trucks"
    const val LABELS = "labels"

    fun settings(tab: String? = null): String = if (tab == null) "settings" else "settings?tab=$tab"
}
