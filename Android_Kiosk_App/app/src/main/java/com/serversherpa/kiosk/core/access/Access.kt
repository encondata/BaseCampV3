package com.serversherpa.kiosk.core.access

/** portal/src/lib/access.ts: rank 60 and up is admin client-side. */
const val ADMIN_RANK = 60

/** Developer, founder and super admin: the API's ensure_super_admin (a Custom URL on a kiosk a
 *  server has registered needs this rank with a global scope). */
const val SUPER_ADMIN_RANK = 80

fun computeCan(perms: Map<String, Map<String, Boolean>>?, resource: String, action: String): Boolean =
    perms?.get(resource)?.get(action) == true
