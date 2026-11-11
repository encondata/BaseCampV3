package com.serversherpa.kiosk.input

/**
 * Logs the first key seen from each external, non-virtual keyboard device (a sled that types its
 * barcodes is one): its name, vendor id and product id, once per device id. It only logs: the
 * caller always passes the key on.
 */
class ExternalKeyLog(private val log: (String) -> Unit) {
    private val seen = HashSet<Int>()

    fun note(deviceId: Int, name: String?, vendorId: Int, productId: Int, external: Boolean, virtual: Boolean) {
        if (!external || virtual) return
        val first = synchronized(seen) { seen.add(deviceId) }
        if (first) log("First key from external keyboard \"${name ?: "unnamed"}\" (device $deviceId, vendor $vendorId, product $productId).")
    }
}
