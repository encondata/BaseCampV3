package com.serversherpa.kiosk.core.people

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private data class P(
    override val id: String, override val displayName: String, override val firstName: String? = null,
    override val lastName: String? = null, override val preferredName: String? = null,
    override val rfidTag: String? = null, override val isWorker: Boolean = false, override val hasAccount: Boolean = false,
    override val badgeUid: String? = null,
) : MatchPerson

class PeopleMatchTest {
    private val jimmy = P("0a1b2c3d-1111-4000-8000-000000000001", "Jimmy Henderson", "James", "Henderson", "Jimmy", rfidTag = "000000000000000000100348")
    private val tina = P("ffffffff-2222-4000-8000-000000000002", "Tina Timeclock", "Tina", "Timeclock", rfidTag = "1003")
    private val smithJones = P("abcdef01-3333-4000-8000-000000000003", "Ann Smith-Jones", "Ann", "Smith-Jones")
    private val index = buildPeopleIndex(listOf(jimmy, tina, smithJones))

    @Test fun exactByBadgeIgnoresPaddingAndCase() {
        assertEquals(jimmy, matchPersonExact(index, "100348"))
        assertEquals(jimmy, matchPersonExact(index, "000000000000000000100348"))
        assertNull(matchPersonExact(index, "Jimmy"))
    }

    @Test fun exactByFullIdAndHexShortId() {
        assertEquals(jimmy, matchPersonExact(index, jimmy.id.uppercase()))
        assertEquals(jimmy, matchPersonExact(index, "0a1b2c3d"))
        assertEquals(smithJones, matchPersonExact(index, "abcdef01"))
    }

    @Test fun anEightLetterNameIsNeverAnId() {
        val hen = P("hendersn-4444-4000-8000-000000000004", "Hen Dersn")
        val i = buildPeopleIndex(listOf(hen))
        assertNull(matchPersonExact(i, "hendersn"))
    }

    @Test fun ambiguousPrefixOnlyForStrictPrefixes() {
        assertTrue(isAmbiguousPrefix(index, "1003"))          // 1003 vs 100348
        assertFalse(isAmbiguousPrefix(index, "100348"))
        assertFalse(isAmbiguousPrefix(index, "9999"))
    }

    @Test fun searchByAnyNamePartsInAnyOrder() {
        assertEquals(listOf(jimmy), searchPeople(index, "jim hen"))
        assertEquals(listOf(jimmy), searchPeople(index, "hen jim"))
        assertEquals(listOf(jimmy), searchPeople(index, "james henderson"))
        assertEquals(listOf(jimmy), searchPeople(index, "henderson j"))
        assertEquals(listOf(smithJones), searchPeople(index, "jones"))
        assertEquals(emptyList<P>(), searchPeople(index, "tina tina"))   // distinct parts
        assertEquals(emptyList<P>(), searchPeople(index, "   "))
    }

    @Test fun rankingExactFullNameFirstThenFewestPartsThenAlpha() {
        val t1 = P("1", "Tina Timeclock", "Tina", "Timeclock")
        val t2 = P("2", "Tina T", "Tina", "T")
        val t3 = P("3", "Tina Timeclock Jr", "Tina", "Timeclock")
        val i = buildPeopleIndex(listOf(t3, t1, t2))
        // "tina timeclock": t2's parts are [tina, t] — "t" is not a prefix match for "timeclock", so t2 is out;
        // t1 (exact full name) ranks ahead of t3 (three parts).
        assertEquals(listOf("1", "3"), searchPeople(i, "tina timeclock").map { it.id })
        // "tina": all three match; fewest parts first, then alphabetical ("tina t" < "tina timeclock").
        assertEquals(listOf("2", "1", "3"), searchPeople(i, "tina").map { it.id })
        assertEquals(2, searchPeople(i, "tina", limit = 2).size)
    }

    @Test fun exactByBadgeUidIgnoresCase() {
        val ann = P("11111111-5555-4000-8000-000000000005", "Ann Badge", badgeUid = "9F2C8E10-AAAA-4BBB-8CCC-0123456789AB")
        val i = buildPeopleIndex(listOf(jimmy, ann))
        assertEquals(ann, matchPersonExact(i, "9f2c8e10-aaaa-4bbb-8ccc-0123456789ab"))
        assertEquals(ann, matchPersonExact(i, "  9F2C8E10-AAAA-4BBB-8CCC-0123456789AB "))
        assertEquals("9f2c8e10-aaaa-4bbb-8ccc-0123456789ab", i.byBadge.keys.single())
        assertNull(matchPersonExact(i, "9f2c8e10-aaaa-4bbb-8ccc-0123456789ac"))
    }

    /** RFID, then badge_uid, then the full id, then the eight-character short id (kiosk/src/lib/peopleMatch.ts). */
    @Test fun exactMatchOrderIsRfidThenBadgeThenFullIdThenShortId() {
        val badgeOwner = P("22222222-6666-4000-8000-000000000006", "Badge Owner", badgeUid = "33333333-7777-4000-8000-000000000007")
        val idOwner = P("33333333-7777-4000-8000-000000000007", "Id Owner", rfidTag = "4242")
        val rfidOwner = P("44444444-8888-4000-8000-000000000008", "Rfid Owner", rfidTag = "22222222")
        val i = buildPeopleIndex(listOf(badgeOwner, idOwner, rfidOwner))
        // a badge_uid that is also someone else's person id: the badge wins
        assertEquals(badgeOwner, matchPersonExact(i, "33333333-7777-4000-8000-000000000007"))
        // an RFID tag that is also someone's short id: the tag wins
        assertEquals(rfidOwner, matchPersonExact(i, "22222222"))
        // the full id still works when nothing earlier claims it
        assertEquals(rfidOwner, matchPersonExact(i, "44444444-8888-4000-8000-000000000008"))
        // and the short id last
        assertEquals(idOwner, matchPersonExact(i, "33333333"))
    }
}
