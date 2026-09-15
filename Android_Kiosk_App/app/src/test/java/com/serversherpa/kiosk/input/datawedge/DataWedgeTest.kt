package com.serversherpa.kiosk.input.datawedge

import android.content.Intent
import android.os.Bundle
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.input.ScanSource
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DataWedgeTest {
    @Test fun notPresentOnAPlainDevice() {
        assertFalse(DataWedge.isPresent(ApplicationProvider.getApplicationContext()))
    }

    @Test fun profileConfigShape() {
        val b = DataWedge.profileConfig("com.serversherpa.kiosk")
        assertEquals("ServerSherpaKiosk", b.getString("PROFILE_NAME"))
        assertEquals("true", b.getString("PROFILE_ENABLED"))
        assertEquals("CREATE_IF_NOT_EXIST", b.getString("CONFIG_MODE"))
        val apps = b.getParcelableArray("APP_LIST")!!.map { it as Bundle }
        assertEquals("com.serversherpa.kiosk", apps[0].getString("PACKAGE_NAME"))
        val plugins = b.getParcelableArrayList<Bundle>("PLUGIN_CONFIG")!!
        val byName = plugins.associateBy { it.getString("PLUGIN_NAME") }
        assertEquals("true", byName["BARCODE"]!!.getBundle("PARAM_LIST")!!.getString("scanner_input_enabled"))
        val intent = byName["INTENT"]!!.getBundle("PARAM_LIST")!!
        assertEquals("true", intent.getString("intent_output_enabled"))
        assertEquals(DataWedge.SCAN_ACTION, intent.getString("intent_action"))
        assertEquals("2", intent.getString("intent_delivery"))
        assertEquals("false", byName["KEYSTROKE"]!!.getBundle("PARAM_LIST")!!.getString("keystroke_output_enabled"))
    }

    @Test fun parseScanReadsDataStringAndLabel() {
        val intent = Intent(DataWedge.SCAN_ACTION)
            .putExtra("com.symbol.datawedge.data_string", " A-100 ")
            .putExtra("com.symbol.datawedge.label_type", "LABEL-TYPE-CODE128")
        val ev = DataWedge.parseScan(intent)!!
        assertEquals("A-100", ev.value); assertEquals(ScanSource.DATAWEDGE, ev.source); assertEquals("CODE128", ev.symbology)
        assertNull(DataWedge.parseScan(Intent("other")))
        assertNull(DataWedge.parseScan(Intent(DataWedge.SCAN_ACTION)))
    }

    @OptIn(DelicateCoroutinesApi::class)
    @Test fun receiverPublishes() {
        val bus = com.serversherpa.kiosk.input.ScanBus()
        var got: com.serversherpa.kiosk.input.ScanEvent? = null
        val job = kotlinx.coroutines.GlobalScope.launch(kotlinx.coroutines.Dispatchers.Unconfined) { bus.events.collect { got = it } }
        val receiver = DataWedgeReceiver(bus)
        receiver.onReceive(ApplicationProvider.getApplicationContext(), Intent(DataWedge.SCAN_ACTION).putExtra("com.symbol.datawedge.data_string", "X1"))
        assertTrue(got?.value == "X1")
        job.cancel()
    }
}
