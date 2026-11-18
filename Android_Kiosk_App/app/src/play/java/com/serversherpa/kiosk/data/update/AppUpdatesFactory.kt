package com.serversherpa.kiosk.data.update

/** The play flavor's update check: none (Google Play updates the app). */
fun createAppUpdates(deps: UpdateDeps): AppUpdates = NoAppUpdates
