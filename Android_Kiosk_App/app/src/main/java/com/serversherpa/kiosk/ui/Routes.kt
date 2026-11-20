package com.serversherpa.kiosk.ui

object Routes {
    const val LOGIN = "login"
    const val HOME = "home"
    const val SETUP = "setup"
    const val SETTINGS = "settings?tab={tab}"
    /** The bundled guides; [TROUBLESHOOTING_TOPIC] is one guide by its topics.json id. */
    const val TROUBLESHOOTING = "troubleshooting"
    const val TROUBLESHOOTING_TOPIC = "troubleshooting/{topicId}"
    const val SCAN = "scan"
    const val ENROLL = "enroll"
    const val TIMECLOCK = "timeclock"
    const val CONTAINERS = "containers"
    const val TRUCKS = "trucks"
    const val LOOKUP = "lookup"
    const val LABELS = "labels"
    const val LABELS_PRINT = "labels/print"
    const val LABELS_PRINTER = "labels/printer"
    const val ROLODEX = "rolodex"
    /** The Notifications page (the Home tile's route); [NOTIFICATIONS_PATTERN] is its nav pattern. */
    const val NOTIFICATIONS = "notifications"
    /** A tapped alert opens the page on `highlight` (a notification id), for its `owner` (a person id). */
    const val NOTIFICATIONS_PATTERN = "notifications?highlight={highlight}&owner={owner}"

    fun settings(tab: String? = null): String = if (tab == null) "settings" else "settings?tab=$tab"

    fun troubleshootingTopic(id: String): String = "$TROUBLESHOOTING/" + android.net.Uri.encode(id)

    fun notifications(highlight: String? = null, owner: String? = null): String {
        val args = listOfNotNull(
            highlight?.let { "highlight=" + android.net.Uri.encode(it) },
            owner?.let { "owner=" + android.net.Uri.encode(it) },
        )
        return if (args.isEmpty()) NOTIFICATIONS else NOTIFICATIONS + "?" + args.joinToString("&")
    }
}
