package com.serversherpa.kiosk.core.settings

/** The checkpoints the non-scanning screens record; keys and defaults
 *  from kiosk/src/lib/checkpointSettings.ts. Only ENROLL has a UI here. */
enum class CheckpointId(val storageKey: String, val fallback: String, val label: String) {
    ENROLL("ss.kiosk.enrollStatus", "pre_stage", "RFID Enroll checkpoint"),
    CONTAINER_PACK("ss.kiosk.containerPackStatus", "in_container", "Container pack checkpoint"),
    CONTAINER_UNPACK("ss.kiosk.containerUnpackStatus", "un_pack", "Container unpack checkpoint"),
    TRUCK_LOAD("ss.kiosk.truckLoadStatus", "on_truck", "Truck load checkpoint"),
    TRUCK_UNLOAD("ss.kiosk.truckUnloadStatus", "received", "Truck unload checkpoint"),
}

/** The stored key, or the default when the portal no longer offers it.
 *  An empty `offered` means the options have not loaded — the stored key stands. */
fun effectiveCheckpoint(id: CheckpointId, stored: String, offered: List<String>): String {
    if (offered.isEmpty()) return stored
    return if (stored in offered) stored else id.fallback
}
