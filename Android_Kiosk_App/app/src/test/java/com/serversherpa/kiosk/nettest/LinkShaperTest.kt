package com.serversherpa.kiosk.nettest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/** The link shaper: bursts cost the delay, bytes cost the speed, and drops stall like TCP does. */
class LinkShaperTest {
    /** Notes every requested sleep and never actually sleeps. */
    private class Recorder : Sleeper {
        val calls = mutableListOf<Long>()
        val total: Long get() = calls.sum()
        override fun sleep(ms: Long) {
            calls += ms
        }
    }

    /**
     * Plays back a fixed list of drop decisions. The shaper draws them through
     * nextDouble(), and a drop happens when the draw is below the drop chance.
     * Drawing more than was scripted fails the test.
     */
    private class ScriptedRandom(private vararg val draws: Double) : Random() {
        var used = 0
            private set

        override fun nextDouble(): Double {
            check(used < draws.size) { "drew more than the ${draws.size} scripted values" }
            return draws[used++]
        }
    }

    private val drop = 0.1
    private val deliver = 0.9

    private fun profileOf(preset: Preset): LinkProfile = requireNotNull(preset.profile)

    private fun shaper(profile: LinkProfile, rec: Recorder, random: Random = Random(42)) =
        LinkShaper(profile, random, rec)

    // --- speed ---

    @Test fun speedOnly() {
        val rec = Recorder()
        assertTrue(shaper(profileOf(Preset.THREE_G), rec).paceDown(97_500, 30_000))
        assertEquals("97,500 bytes at 780 kbps", 1_000.0, rec.total.toDouble(), 10.0)
    }

    @Test fun uploadsUseTheUploadSpeed() {
        val rec = Recorder()
        assertTrue(shaper(profileOf(Preset.THREE_G), rec).paceUp(41_250, 30_000))
        assertEquals("41,250 bytes at 330 kbps", 1_000.0, rec.total.toDouble(), 10.0)
    }

    @Test fun smallCostsAreHeldAndSleptTogether() {
        val rec = Recorder()
        assertTrue(shaper(profileOf(Preset.WIFI_AC), rec).paceDown(1_000_000, 30_000))
        assertEquals("1,000,000 bytes at 250,000 kbps", 32.0, rec.total.toDouble(), 1.0)
        assertTrue("sleeps are at least 10 ms apart from the last flush: ${rec.calls}", rec.calls.dropLast(1).all { it >= 10 })
        assertTrue("a few sleeps, not one per chunk: ${rec.calls}", rec.calls.size <= 4)
    }

    @Test fun noLimitCostsNothing() {
        val rec = Recorder()
        assertTrue(shaper(LinkProfile(), rec).paceDown(1_000_000, 30_000))
        assertEquals(0L, rec.total)
        assertTrue(rec.calls.isEmpty())
    }

    @Test fun noBytesCostNothing() {
        val rec = Recorder()
        assertTrue(shaper(profileOf(Preset.THREE_G), rec).paceDown(0, 30_000))
        assertTrue(shaper(LinkProfile(downDropPct = 100.0), rec).paceDown(0, 30_000))
        assertTrue(rec.calls.isEmpty())
    }

    // --- delay ---

    @Test fun burstDelays() {
        val up = Recorder()
        shaper(profileOf(Preset.EDGE), up).sendBurst()
        assertEquals(400L, up.total)
        val down = Recorder()
        shaper(profileOf(Preset.EDGE), down).receiveBurst()
        assertEquals(400L, down.total)
    }

    @Test fun burstsUseTheirOwnDirection() {
        val profile = LinkProfile(upDelayMs = 30, downDelayMs = 70)
        val up = Recorder()
        shaper(profile, up).sendBurst()
        assertEquals(listOf(30L), up.calls)
        val down = Recorder()
        shaper(profile, down).receiveBurst()
        assertEquals(listOf(70L), down.calls)
    }

    @Test fun burstsOnAnUndelayedLinkSleepNothing() {
        val rec = Recorder()
        val shaper = shaper(LinkProfile(), rec)
        shaper.sendBurst()
        shaper.receiveBurst()
        assertTrue(rec.calls.isEmpty())
    }

    @Test fun roundTripIsUploadPlusDownloadDelay() {
        assertEquals(60L, shaper(LinkProfile(upDelayMs = 20, downDelayMs = 40), Recorder()).roundTripMs())
        assertEquals(0L, shaper(LinkProfile(), Recorder()).roundTripMs())
    }

    // --- connecting ---

    @Test fun connectRoundTrip() {
        val rec = Recorder()
        assertTrue(shaper(profileOf(Preset.LTE), rec).connect(15_000))
        assertEquals(100L, rec.total)
    }

    @Test fun connectOnACleanLinkSleepsNothing() {
        val rec = Recorder()
        assertTrue(shaper(LinkProfile(), rec).connect(15_000))
        assertTrue(rec.calls.isEmpty())
    }

    @Test fun lostHandshakeIsRetriedAfterOneSecond() {
        val rec = Recorder()
        // Up 50% and down 50% lose an attempt 75% of the time, so a 0.7 draw is a loss.
        val random = ScriptedRandom(0.7, 0.8)
        val profile = LinkProfile(upDelayMs = 50, downDelayMs = 50, upDropPct = 50.0, downDropPct = 50.0)
        assertTrue(shaper(profile, rec, random).connect(15_000))
        assertEquals("the round trip, then one SYN retry wait", listOf(100L, 1_000L), rec.calls)
        assertEquals(2, random.used)
    }

    @Test fun connectAttemptsBackOffLikeSynRetries() {
        val rec = Recorder()
        val random = ScriptedRandom(drop, drop, drop, drop, deliver)
        assertTrue(shaper(LinkProfile(upDropPct = 50.0), rec, random).connect(30_000))
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L), rec.calls)
    }

    @Test fun connectTimeoutCoversTheRoundTrip() {
        val rec = Recorder()
        assertFalse(shaper(LinkProfile(upDelayMs = 600, downDelayMs = 600), rec).connect(1_000))
        assertEquals(listOf(1_000L), rec.calls)
    }

    @Test fun connectGivesUpPartWayThroughARetryWait() {
        val rec = Recorder()
        val profile = LinkProfile(upDelayMs = 50, downDelayMs = 50, upDropPct = 100.0)
        assertFalse(shaper(profile, rec).connect(1_500))
        assertEquals("round trip, first retry wait, then what is left of the second", listOf(100L, 1_000L, 400L), rec.calls)
    }

    // --- drops ---

    @Test fun isolatedDrop() {
        val rec = Recorder()
        val random = ScriptedRandom(drop, deliver)
        val profile = LinkProfile(downDelayMs = 100, upDelayMs = 100, downDropPct = 50.0)
        assertTrue(shaper(profile, rec, random).paceDown(1_000, 30_000))
        assertEquals("max(200, round trip of 200)", listOf(200L), rec.calls)
        assertEquals(2, random.used)
    }

    @Test fun firstDropCostsTheRoundTripWhenThatIsLonger() {
        val rec = Recorder()
        val profile = LinkProfile(downDelayMs = 300, upDelayMs = 300, downDropPct = 50.0)
        assertTrue(shaper(profile, rec, ScriptedRandom(drop, deliver)).paceDown(1_000, 30_000))
        assertEquals(listOf(600L), rec.calls)
    }

    @Test fun dropStallComesBeforeTheSpeedCost() {
        val rec = Recorder()
        // One full 1,460-byte chunk at 584 kbps costs exactly 20 ms.
        val profile = LinkProfile(downKbps = 584, downDelayMs = 100, upDelayMs = 100, downDropPct = 50.0)
        assertTrue(shaper(profile, rec, ScriptedRandom(drop, deliver)).paceDown(1_460, 30_000))
        assertEquals(listOf(200L, 20L), rec.calls)
    }

    @Test fun consecutiveDropsBackOff() {
        val rec = Recorder()
        val random = ScriptedRandom(drop, drop, drop, drop, drop, deliver)
        assertTrue(shaper(LinkProfile(downDropPct = 50.0), rec, random).paceDown(1_000, 30_000))
        assertEquals(listOf(200L, 1_000L, 2_000L, 4_000L, 8_000L), rec.calls)
    }

    @Test fun backOffStopsGrowingAtOneMinute() {
        val rec = Recorder()
        val random = ScriptedRandom(drop, drop, drop, drop, drop, drop, drop, drop, drop, deliver)
        assertTrue(shaper(LinkProfile(downDropPct = 50.0), rec, random).paceDown(1_000, 1_000_000))
        assertEquals(
            listOf(200L, 1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L),
            rec.calls,
        )
    }

    @Test fun deliveryEndsTheRunOfDrops() {
        val rec = Recorder()
        // Chunk one is dropped twice, then gets through. Chunk two starts a fresh run with a fast retransmit.
        val random = ScriptedRandom(drop, drop, deliver, drop, deliver)
        assertTrue(shaper(LinkProfile(downDropPct = 50.0), rec, random).paceDown(2_920, 30_000))
        assertEquals(listOf(200L, 1_000L, 200L), rec.calls)
    }

    @Test fun timeoutCutsAStallShort() {
        val rec = Recorder()
        val random = ScriptedRandom(drop, drop, drop)
        assertFalse(shaper(LinkProfile(downDropPct = 50.0), rec, random).paceDown(10, 1_500))
        assertEquals("200 + 1,000 + what is left of the next 2,000", listOf(200L, 1_000L, 300L), rec.calls)
        assertEquals("it stops drawing once it has given up", 3, random.used)
    }

    @Test fun totalLossHitsTimeout() {
        val paced = Recorder()
        assertFalse(shaper(profileOf(Preset.LOSS_100), paced).paceDown(10, 5_000))
        assertEquals(5_000L, paced.total)

        val connected = Recorder()
        assertFalse(shaper(profileOf(Preset.LOSS_100), connected).connect(15_000))
        assertEquals(15_000L, connected.total)
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L), connected.calls)
    }

    @Test fun dropsApplyToTheirOwnDirection() {
        val profile = LinkProfile(upDropPct = 100.0, downDropPct = 0.0)

        val down = Recorder()
        assertTrue(shaper(profile, down, ScriptedRandom()).paceDown(10_000, 5_000))
        assertTrue(down.calls.isEmpty())

        val up = Recorder()
        assertFalse(shaper(profile, up).paceUp(10, 5_000))
        assertEquals(5_000L, up.total)
    }

    @Test fun aLinkWithoutDropsNeverDrawsRandomness() {
        val random = ScriptedRandom()
        val shaper = shaper(profileOf(Preset.THREE_G), Recorder(), random)
        assertTrue(shaper.connect(15_000))
        assertTrue(shaper.paceUp(5_000, 30_000))
        assertTrue(shaper.paceDown(5_000, 30_000))
        assertEquals(0, random.used)
    }
}
