package com.serversherpa.kiosk

import android.os.Looper
import androidx.compose.ui.test.junit4.ComposeTestRule
import org.robolectric.Shadows.shadowOf

/**
 * [ComposeTestRule.waitUntil] that runs Robolectric's main looper before each check.
 *
 * waitUntil itself only advances Compose's clock and sleeps between checks, and Robolectric's
 * main looper runs only when something idles it. Work on the main thread (a ViewModel's
 * viewModelScope) that resumes there from another thread (a DataStore or Room read, a
 * `withContext(io)`, the Bluetooth link's own dispatcher) then waits in the looper's queue until
 * the wait times out, more often the busier the machine. A condition that queries semantics
 * (`onAllNodes…().fetchSemanticsNodes()`) already idles the looper on every check; a condition on
 * plain state (a fake's calls, a StateFlow, the database) needs this.
 */
fun ComposeTestRule.waitUntilIdlingMain(timeoutMillis: Long = 5_000, condition: () -> Boolean) =
    waitUntil(timeoutMillis) {
        shadowOf(Looper.getMainLooper()).idle()
        condition()
    }
