package com.serversherpa.kiosk.core.settings

enum class SettingsTabId(val wire: String) {
    APPEARANCE("appearance"), SOUND("sound"), DEVICES("devices"), THIS_KIOSK("this-kiosk"),
    ADMIN("admin"), DEVELOPER("developer");

    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

enum class TabRequirement { ADMIN, DEVELOPER }

data class SettingsTab(
    val id: SettingsTabId,
    val label: String,
    val blurb: String,
    val requires: TabRequirement? = null,
    /** Visible signed out. */
    val anon: Boolean = false,
)

val SETTINGS_TABS: List<SettingsTab> = listOf(
    SettingsTab(SettingsTabId.APPEARANCE, "Appearance", "Theme, accent, and text size for this kiosk."),
    SettingsTab(SettingsTabId.SOUND, "Sound", "Scan and alert sounds."),
    SettingsTab(SettingsTabId.DEVICES, "Devices", "Scanners, printers, and readers attached to this kiosk."),
    SettingsTab(SettingsTabId.THIS_KIOSK, "This Kiosk", "This kiosk's name, identity, and connection.", anon = true),
    SettingsTab(SettingsTabId.ADMIN, "Admin", "Kiosk administration.", requires = TabRequirement.ADMIN),
    SettingsTab(SettingsTabId.DEVELOPER, "Developer", "Diagnostics and developer tools.", requires = TabRequirement.DEVELOPER),
)

val DEFAULT_TAB = SettingsTabId.APPEARANCE

fun visibleTabs(isAdmin: Boolean, isDeveloper: Boolean, signedIn: Boolean, tabs: List<SettingsTab> = SETTINGS_TABS): List<SettingsTab> {
    if (!signedIn) return tabs.filter { it.anon }
    return tabs.filter {
        when (it.requires) {
            TabRequirement.ADMIN -> isAdmin
            TabRequirement.DEVELOPER -> isDeveloper
            null -> true
        }
    }
}
