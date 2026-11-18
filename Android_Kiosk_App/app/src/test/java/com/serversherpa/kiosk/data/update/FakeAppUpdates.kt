package com.serversherpa.kiosk.data.update

import com.serversherpa.kiosk.core.update.UpdateOffer
import kotlinx.coroutines.flow.MutableStateFlow

/** A supported [AppUpdates] whose state a test sets directly; each call is counted. */
class FakeAppUpdates(
    initial: UpdateState = UpdateState.Idle,
    bannerVisible: Boolean = false,
) : AppUpdates {
    override val supported = true
    override val state = MutableStateFlow(initial)
    override val homeBannerVisible = MutableStateFlow(bannerVisible)
    var starts = 0
    var checks = 0
    var updates = 0
    var laters = 0
    override fun start() { starts++ }
    override fun check() { checks++ }
    override fun update() { updates++ }
    override fun later() { laters++ }
}

fun fakeOffer(
    versionName: String = "0.1.2",
    build: Long = 12,
    notes: String? = "Faster scans.",
    size: Long? = 12_400_000,
) = UpdateOffer(versionName, build, notes, size, "https://devices.example.com/dl/abc")
