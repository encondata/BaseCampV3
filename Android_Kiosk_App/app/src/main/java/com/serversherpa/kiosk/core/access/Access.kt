package com.serversherpa.kiosk.core.access

/** portal/src/lib/access.ts: rank 60 and up is admin client-side. */
const val ADMIN_RANK = 60

fun computeCan(perms: Map<String, Map<String, Boolean>>?, resource: String, action: String): Boolean =
    perms?.get(resource)?.get(action) == true
