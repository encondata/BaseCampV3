package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

/**
 * One item of GET /kiosk/notifications: the portal inbox's item (NotificationInboxItemOut) plus
 * [push_snoozed_until], when a snooze push is due (null when none). Times are ISO-8601 with an
 * offset. The payload isn't read here, so it isn't kept.
 */
@Serializable
data class KioskNotification(
    val id: String,
    val kind: String = "",
    val category: String? = null,
    val title: String = "",
    val body: String = "",
    val link: String? = null,
    val created_at: String,
    val read_at: String? = null,
    val push_snoozed_until: String? = null,
)

/** GET /kiosk/notifications: one page of the signed-in person's live inbox, newest first.
 *  [unread_count] is overall; [next_cursor] is null on the last page. */
@Serializable
data class KioskNotificationsPage(
    val unread_count: Int = 0,
    val items: List<KioskNotification> = emptyList(),
    val next_cursor: String? = null,
    val total: Int = 0,
)
