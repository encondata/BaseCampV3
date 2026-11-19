package com.serversherpa.kiosk

import com.serversherpa.kiosk.input.rfid.FakeRfidReader

/** The app under Robolectric for tests that build [MainActivity] (preflight ruling 11): the
 *  test container, over [reader]. Select it with `@Config(application = TestKioskApplication::class)`. */
class TestKioskApplication : KioskApplication() {
    val reader = FakeRfidReader()

    override fun createContainer(): AppContainer = testContainer(reader)
}
