package com.serversherpa.kiosk.input.rfid

import androidx.test.core.app.ApplicationProvider
import com.zebra.rfid.api3.ENUM_TRANSPORT
import com.zebra.rfid.api3.Readers
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Proof that the vendor `.aar`'s support-library references actually resolve
 * on this app's classpath, not just that `ZebraRfidReader.connect()` reports
 * a failure instead of crashing (that's `ZebraRfidReaderTest`'s job, and its
 * `catch (e: LinkageError)` would hide exactly the bug this test exists to
 * catch).
 *
 * Constructing `Readers` under Robolectric — no Bluetooth adapter, no reader
 * present — is expected to fail for an ordinary reason (Robolectric's shadow
 * Bluetooth stack, or simply "no reader found" once `GetAvailableRFIDReaderList`
 * is called). That is a fine, expected failure. What must never happen is a
 * `LinkageError`/`NoClassDefFoundError` while resolving a class the `.aar`
 * references — that means a class the vendor code needs (observed:
 * `android.support.v4.content.LocalBroadcastManager`) is missing from the
 * classpath, which is the exact bug this whole task fixes.
 *
 * The two outcomes are told apart explicitly below: a `LinkageError` fails
 * the test with the missing class named in the message, and every other
 * `Throwable` (or a clean return) is treated as the ordinary "no hardware
 * here" case and passes.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ZebraReadersConstructibleTest {
    @Test fun constructingReadersNeverThrowsALinkageError() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        try {
            val readers = Readers(context, ENUM_TRANSPORT.ALL)
            // Constructed cleanly — great, but also exercise the call that
            // triggered the LocalBroadcastManager NoClassDefFoundError in the
            // first place, in case the constructor alone doesn't touch it on
            // every Robolectric run.
            readers.GetAvailableRFIDReaderList()
            readers.Dispose()
        } catch (e: LinkageError) {
            fail(
                "Readers construction hit a LinkageError — a class the vendor .aar " +
                    "references is missing from the classpath (expected this to be " +
                    "fixed by now): ${e::class.qualifiedName}: ${e.message}"
            )
        } catch (e: Throwable) {
            // Any other failure (no Bluetooth adapter under Robolectric, no
            // reader present, an SDK-internal IllegalStateException, etc.) is
            // the expected, ordinary "no hardware here" outcome, not the bug
            // this test guards against.
            assertTrue(
                "unexpected failure type ${e::class.qualifiedName}: ${e.message}",
                e !is LinkageError,
            )
        }
    }
}
