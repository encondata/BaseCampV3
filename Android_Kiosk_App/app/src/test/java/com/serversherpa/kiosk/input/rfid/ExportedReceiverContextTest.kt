package com.serversherpa.kiosk.input.rfid

import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * `ExportedReceiverContext` exists only to satisfy the Zebra RFIDAPI3 vendor
 * library's un-flagged `registerReceiver` calls (see that class's doc for the
 * full story). These tests prove the wrapper itself does what it claims —
 * that it supplies `RECEIVER_EXPORTED` where the caller specified nothing,
 * and leaves an explicit flag alone. They do NOT prove the vendor library
 * connects on a real device; the platform's API-34 enforcement isn't
 * reproducible under Robolectric (see `ZebraRfidReaderTest`'s doc for the
 * same limitation), so only hardware can show that.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ExportedReceiverContextTest {

    /** Records exactly what reached the base `Context` instead of actually
     *  registering anything — a test double for the base `Context` the
     *  wrapper delegates to, standing in for the real registration Android
     *  would otherwise perform. */
    private class RecordingContext(base: Context) : ContextWrapper(base) {
        data class Call(
            val receiver: BroadcastReceiver?,
            val filter: IntentFilter?,
            val permission: String?,
            val scheduler: Handler?,
            val flags: Int?,
        )

        var lastCall: Call? = null
            private set

        override fun registerReceiver(receiver: BroadcastReceiver?, filter: IntentFilter?): Intent? {
            lastCall = Call(receiver, filter, null, null, flags = null)
            return null
        }

        override fun registerReceiver(receiver: BroadcastReceiver?, filter: IntentFilter?, flags: Int): Intent? {
            lastCall = Call(receiver, filter, null, null, flags)
            return null
        }

        override fun registerReceiver(
            receiver: BroadcastReceiver?,
            filter: IntentFilter?,
            broadcastPermission: String?,
            scheduler: Handler?,
        ): Intent? {
            lastCall = Call(receiver, filter, broadcastPermission, scheduler, flags = null)
            return null
        }

        override fun registerReceiver(
            receiver: BroadcastReceiver?,
            filter: IntentFilter?,
            broadcastPermission: String?,
            scheduler: Handler?,
            flags: Int,
        ): Intent? {
            lastCall = Call(receiver, filter, broadcastPermission, scheduler, flags)
            return null
        }
    }

    private val fakeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = Unit
    }

    private fun wrapped(): Pair<ExportedReceiverContext, RecordingContext> {
        val base = RecordingContext(ApplicationProvider.getApplicationContext())
        return ExportedReceiverContext(base) to base
    }

    @Test fun registeringWithNoFlagsReachesTheBaseContextWithReceiverExported() {
        val (context, base) = wrapped()
        val filter = IntentFilter()

        context.registerReceiver(fakeReceiver, filter)

        val call = base.lastCall
        assertSame(fakeReceiver, call?.receiver)
        assertSame(filter, call?.filter)
        assertEquals(Context.RECEIVER_EXPORTED, call?.flags)
    }

    @Test fun registeringWithAnExplicitFlagPassesItThroughUnchanged() {
        val (context, base) = wrapped()
        val filter = IntentFilter()

        context.registerReceiver(fakeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)

        val call = base.lastCall
        assertEquals(Context.RECEIVER_NOT_EXPORTED, call?.flags)
    }

    @Test fun thePermissionAndHandlerOverloadWithNoFlagsAlsoGetsReceiverExported() {
        val (context, base) = wrapped()
        val filter = IntentFilter()

        context.registerReceiver(fakeReceiver, filter, "some.broadcast.PERMISSION", null)

        val call = base.lastCall
        assertSame(fakeReceiver, call?.receiver)
        assertSame(filter, call?.filter)
        assertEquals("some.broadcast.PERMISSION", call?.permission)
        assertNull(call?.scheduler)
        assertEquals(Context.RECEIVER_EXPORTED, call?.flags)
    }

    @Test fun thePermissionAndHandlerOverloadWithAnExplicitFlagPassesItThroughUnchanged() {
        val (context, base) = wrapped()
        val filter = IntentFilter()

        context.registerReceiver(fakeReceiver, filter, "some.broadcast.PERMISSION", null, Context.RECEIVER_NOT_EXPORTED)

        val call = base.lastCall
        assertEquals("some.broadcast.PERMISSION", call?.permission)
        assertEquals(Context.RECEIVER_NOT_EXPORTED, call?.flags)
    }

    @Test fun getApplicationContextReturnsTheWrapperItselfSoEscapesAreStillRouted() {
        val (context, _) = wrapped()
        assertSame(context, context.applicationContext)
    }
}
