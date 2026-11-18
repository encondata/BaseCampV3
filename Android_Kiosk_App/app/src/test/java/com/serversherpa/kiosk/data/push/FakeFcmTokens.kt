package com.serversherpa.kiosk.data.push

/** An [FcmTokens] for tests: no Firebase. Each call is counted before it answers. */
class FakeFcmTokens(
    var tokenResult: suspend () -> String = { "fcm-token-1" },
    var deleteResult: suspend () -> Unit = { },
) : FcmTokens {
    @Volatile var tokenCalls = 0
    @Volatile var deletes = 0
    override suspend fun token(): String { tokenCalls++; return tokenResult() }
    override suspend fun delete() { deletes++; deleteResult() }
}
