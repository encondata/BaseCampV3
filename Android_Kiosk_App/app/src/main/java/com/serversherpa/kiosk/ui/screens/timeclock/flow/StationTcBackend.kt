package com.serversherpa.kiosk.ui.screens.timeclock.flow

import androidx.room.withTransaction
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.data.api.StationApi
import com.serversherpa.kiosk.data.api.StationCredentials
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.station.StationStatus

/**
 * A Time Clock station, signed out or not (spec section 6): people, status and punches under
 * the station key and the kiosk's serial, never the session. The people list replaces the local
 * copy in Room (people only: a station has no move data), so a station that goes offline still
 * finds names; a punch still needs the connection.
 *
 * Station errors go to [status] first: a dropped key (401, `wrong_station_type`) or a lapsed
 * registration (`kiosk_not_registered`) is Welcome's to show, so the people read then answers
 * with the local copy rather than a "can't load" line under the notice. With no key at all,
 * nothing is sent.
 */
class StationTcBackend(
    private val db: KioskDatabase,
    private val api: StationApi,
    private val status: StationStatus,
    private val identity: Identity,
    private val zone: () -> String = ::deviceZone,
) : TcBackend {
    private suspend fun <T> keyed(block: suspend (creds: StationCredentials, serial: String) -> T): T {
        val creds = status.credentials() ?: throw ApiError(401, "station_key_missing")
        val serial = identity.get().serial
        return try {
            block(creds, serial).also { status.ok() }
        } catch (e: ApiError) {
            status.failed(e)
            throw e
        }
    }

    override suspend fun people(): List<KioskPersonRow> {
        val fetched = try {
            keyed { creds, serial -> api.people(creds, serial) }
        } catch (e: ApiError) {
            val local = db.people().all()
            // A station error shows on Welcome; offline keeps the last list when there is one.
            if (e.status == 401 || e.status == 403 || (e.isNetwork && local.isNotEmpty())) return local.map { it.toRow() }
            throw e
        }
        db.withTransaction {
            db.people().deleteAll()
            db.people().insertAll(fetched.map { it.toEntity() })
        }
        return fetched
    }

    override suspend fun status(personId: String): KioskTimeclockStatus =
        keyed { creds, serial -> api.status(creds, serial, personId, zone()) }

    override suspend fun clockIn(personId: String): KioskTimeclockStatus =
        keyed { creds, serial -> api.clockIn(creds, serial, personId, zone()) }

    override suspend fun clockOut(personId: String): KioskTimeclockStatus =
        keyed { creds, serial -> api.clockOut(creds, serial, personId, zone()) }
}
