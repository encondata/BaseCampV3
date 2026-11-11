package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.triggerTypePasses
import java.lang.reflect.Modifier
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Spec test 22: the vendor members the sled adapter calls exist in the
 * bundled `.aar` with the shapes the adapter was written against. The vendor
 * library is a hand-placed file, so a swapped or upgraded copy would
 * otherwise show up only on a sled. Every member is looked up by name
 * through reflection, so one run lists everything that moved instead of
 * stopping at the first compile error, and nothing here talks to hardware.
 */
class ZebraVendorPinTest {
    @Test fun theVendorMembersThisAppCallsExist() {
        val problems = mutableListOf<String>()
        fun check(what: String, body: () -> String?) {
            val problem = try {
                body()
            } catch (t: Throwable) {
                "${t::class.java.simpleName}: ${t.message}"
            }
            if (problem != null) problems += "$what: $problem"
        }

        val config = vendorClass(API3 + "Config")
        val keyLayout = vendorClass(API3 + "ENUM_NEW_KEYLAYOUT_TYPE")
        val events = vendorClass(API3 + "Events")
        val eventType = vendorClass(API3 + "RFID_EVENT_TYPE")
        val attributeInfo = vendorClass(API3 + "AttributeInfo")
        val setAttribute = vendorClass(API3 + "SetAttribute")

        check("Config.setKeylayoutType(ENUM_NEW_KEYLAYOUT_TYPE, ENUM_NEW_KEYLAYOUT_TYPE)") {
            config.getMethod("setKeylayoutType", keyLayout, keyLayout).let { null }
        }
        listOf("RFID" to 0, "SLED_SCAN" to 1, "TERMINAL_SCAN" to 2, "SCAN_NOTIFY" to 3, "NO_ACTION" to 4).forEach { (name, value) ->
            check("ENUM_NEW_KEYLAYOUT_TYPE.$name.getEnumValue() == $value") {
                val constant = keyLayout.enumConstants.orEmpty().firstOrNull { (it as Enum<*>).name == name }
                    ?: return@check "no such constant"
                val actual = keyLayout.getMethod("getEnumValue").invoke(constant)
                if (actual == value) null else "was $actual"
            }
        }
        check("IEvents.HandheldTriggerEventData.getHandheldTriggerType()") {
            vendorClass(API3 + "IEvents\$HandheldTriggerEventData").getMethod("getHandheldTriggerType")
                .returns(vendorClass(API3 + "HANDHELD_TRIGGER_TYPE"))
        }
        // The trigger-type deny-list (ruling 26) compares the type's toString()
        // with "HANDHELD_TRIGGER_SCAN". The type is a plain class whose
        // toString() returns a private name, not an enum, so a changed copy
        // would let scan-trigger pulls start sweeps with nothing failing.
        check("HANDHELD_TRIGGER_TYPE.HANDHELD_TRIGGER_SCAN.toString() is the name the deny-list drops") {
            // Its static initializer builds three instances and a map, nothing Android.
            val type = Class.forName(API3 + "HANDHELD_TRIGGER_TYPE", true, javaClass.classLoader)
            val name = type.getField("HANDHELD_TRIGGER_SCAN").get(null)?.toString()
                ?: return@check "the constant is null"
            when {
                name != "HANDHELD_TRIGGER_SCAN" -> "is \"$name\""
                triggerTypePasses(name) -> "passes the deny-list"
                else -> null
            }
        }
        listOf("setReaderDisconnectEvent", "setInventoryStartEvent", "setInventoryStopEvent").forEach { name ->
            check("Events.$name(boolean)") { events.getMethod(name, Boolean::class.javaPrimitiveType).let { null } }
        }
        check("Events.isEventRegistered(RFID_EVENT_TYPE)") {
            events.getMethod("isEventRegistered", eventType).returns(Boolean::class.javaPrimitiveType!!)
        }
        check("public RFID_EVENT_TYPE.HANDHELD_TRIGGER_EVENT") {
            val field = eventType.getField("HANDHELD_TRIGGER_EVENT")
            when {
                !Modifier.isStatic(field.modifiers) -> "not static"
                field.type != eventType -> "is a ${field.type.name}"
                else -> null
            }
        }
        check("Actions.purgeTags() returning boolean") {
            vendorClass(API3 + "Actions").getMethod("purgeTags").returns(Boolean::class.javaPrimitiveType!!)
        }
        check("ReaderCapabilities.getTransmitPowerLevelValues()") {
            vendorClass(API3 + "ReaderCapabilities").getMethod("getTransmitPowerLevelValues").returns(IntArray::class.java)
        }
        // Connect step 9's dump of what ruling 24 leaves as the sled has it.
        val rfConfig = vendorClass(API3 + "Antennas\$AntennaRfConfig")
        check("Antennas.getAntennaRfConfig(int)") {
            vendorClass(API3 + "Antennas").getMethod("getAntennaRfConfig", Int::class.javaPrimitiveType).returns(rfConfig)
        }
        check("AntennaRfConfig.getrfModeTableIndex()") { rfConfig.getMethod("getrfModeTableIndex").returns(Long::class.javaPrimitiveType!!) }
        check("AntennaRfConfig.getTari()") { rfConfig.getMethod("getTari").returns(Long::class.javaPrimitiveType!!) }
        check("PreFilters.length()") { vendorClass(API3 + "PreFilters").getMethod("length").returns(Int::class.javaPrimitiveType!!) }
        check("Config.getAttribute(int, AttributeInfo)") {
            config.getMethod("getAttribute", Int::class.javaPrimitiveType, attributeInfo).returns(attributeInfo)
        }
        check("AttributeInfo.getAttNum()") {
            attributeInfo.getMethod("getAttNum").returns(Int::class.javaPrimitiveType!!)
        }
        check("Config.setAttribute(SetAttribute)") { config.getMethod("setAttribute", setAttribute).let { null } }
        check("SetAttribute(int, String, String, int)") {
            setAttribute.getConstructor(
                Int::class.javaPrimitiveType, String::class.java, String::class.java, Int::class.javaPrimitiveType,
            ).let { null }
        }
        check("RegulatoryConfig.setEnabledChannels(String[])") {
            vendorClass(API3 + "RegulatoryConfig").getMethod("setEnabledChannels", Array<String>::class.java).let { null }
        }
        check("OperationFailureException.getVendorMessage()") {
            vendorClass(API3 + "OperationFailureException").getMethod("getVendorMessage").returns(String::class.java)
        }
        check("SDKHandler(Context, boolean)") {
            vendorClass(SCANNER + "SDKHandler")
                .getConstructor(Class.forName("android.content.Context"), Boolean::class.javaPrimitiveType).let { null }
        }
        check("DCSSDK_MODE.DCSSDK_OPMODE_DISABLED") { enumConstant(SCANNER + "DCSSDKDefs\$DCSSDK_MODE", "DCSSDK_OPMODE_DISABLED") }
        listOf(
            "DCSSDK_RESULT_SCANNER_ALREADY_ACTIVE",
            "DCSSDK_RESULT_SCANNER_NOT_AVAILABLE",
            "DCSSDK_RESULT_SCANNER_NOT_ACTIVE",
        ).forEach { name ->
            check("DCSSDK_RESULT.$name") { enumConstant(SCANNER + "DCSSDKDefs\$DCSSDK_RESULT", name) }
        }

        assertTrue(
            "Vendor members the sled adapter calls are missing or changed in the bundled .aar:\n" +
                problems.joinToString("\n"),
            problems.isEmpty(),
        )
    }

    /** Loads a vendor class without running its static initializer. */
    private fun vendorClass(name: String): Class<*> = Class.forName(name, false, javaClass.classLoader)

    /** Null when the method returns [expected], else what it returns. */
    private fun java.lang.reflect.Method.returns(expected: Class<*>): String? =
        if (returnType == expected) null else "returns ${returnType.name}, not ${expected.name}"

    private fun enumConstant(className: String, name: String): String? {
        val type = vendorClass(className)
        val field = type.getField(name)
        return if (field.isEnumConstant) null else "not an enum constant"
    }

    private companion object {
        const val API3 = "com.zebra.rfid.api3."
        const val SCANNER = "com.zebra.scannercontrol."
    }
}
