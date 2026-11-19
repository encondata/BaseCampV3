package com.serversherpa.kiosk.data.push

/**
 * An FCM data message from the server's push sender (api/.../notifications/push.py). Every value
 * arrives as a string. [parse] reads the two types the app knows; anything else is null and ignored.
 */
sealed class PushMessage {
    /** `type: notification`: an alert to show (or replace: a snooze push has the same id). */
    data class Notification(
        val notificationId: String,
        val personId: String,
        val kind: String,
        val title: String,
        val body: String,
        val critical: Boolean,
        /** ISO-8601, with an offset. */
        val createdAt: String,
    ) : PushMessage()

    /** `type: clear`: the notification was read, hidden or snoozed elsewhere; take its alert down. */
    data class Clear(val notificationId: String) : PushMessage()

    companion object {
        fun parse(data: Map<String, String>): PushMessage? {
            val id = data["notification_id"]?.takeIf { it.isNotBlank() } ?: return null
            return when (data["type"]) {
                "notification" -> Notification(
                    notificationId = id,
                    personId = data["person_id"].orEmpty(),
                    kind = data["kind"].orEmpty(),
                    title = data["title"].orEmpty(),
                    body = data["body"].orEmpty(),
                    critical = data["critical"] == "true",
                    createdAt = data["created_at"].orEmpty(),
                )
                "clear" -> Clear(id)
                else -> null
            }
        }
    }
}
