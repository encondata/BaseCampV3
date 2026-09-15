package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.core.model.HeartbeatResult
import com.serversherpa.kiosk.core.model.PairCreated
import com.serversherpa.kiosk.core.model.PairPoll
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.core.model.SystemStatus

/** Every endpoint the kiosk calls — kiosk/src/lib/api.ts, function for function.
 *  Implementations throw ApiError on any non-2xx or transport failure
 *  unless a member says otherwise. */
interface KioskApi {
    suspend fun login(email: String, password: String): SessionData
    suspend fun logout()
    suspend fun systemStatus(): SystemStatus
    suspend fun createPairRequest(serial: String, name: String): PairCreated
    /** 404 reads as EXPIRED; an approved answer stores the session. */
    suspend fun pollPair(code: String, pollToken: String): PairPoll
    suspend fun heartbeat(body: HeartbeatIn): HeartbeatResult
    /** Never throws — the kiosk is dropping its own token either way. */
    suspend fun signOut(serial: String)
}
