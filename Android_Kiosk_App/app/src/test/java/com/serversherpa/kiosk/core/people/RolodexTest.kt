package com.serversherpa.kiosk.core.people

import com.serversherpa.kiosk.core.model.RolodexCompany
import com.serversherpa.kiosk.core.model.RolodexDetail
import com.serversherpa.kiosk.core.model.RolodexRow
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun row(
    id: String, first: String, last: String, preferred: String? = null, job: String? = null,
    company: String? = null, status: String = "active", hasPhoto: Boolean = true,
) = RolodexRow(
    person_id = id, first_name = first, last_name = last, preferred_name = preferred,
    display_name = "${preferred ?: first} $last", job_title = job,
    company = company?.let { RolodexCompany("c-$it", it) },
    status = status, status_label = status.replaceFirstChar { it.uppercase() }, has_photo = hasPhoto,
)

class RolodexTest {
    private val abbott = row("p-abbott", "Ann", "Abbott", status = "standby")
    private val nunez = row("p-nunez", "José", "Núñez", job = "Mover")
    private val nash = row("p-nash", "Nina", "Nash", hasPhoto = false)
    private val obrien = row("p-obrien", "Sean", "O'Brien", status = "blacklist")
    private val cruz = row("p-cruz", "Maria", "de la Cruz", preferred = "Mari")
    private val crew = row("p-3m", "Team", "3M Crew")
    private val rigger = row("p-reed", "Marcus", "Reed", job = "Rigger", company = "Summit Crew")

    // ── fold ────────────────────────────────────────────────────────

    @Test fun foldLowercasesStripsAccentsAndDropsPunctuation() {
        assertEquals("nunez", fold("Núñez"))
        assertEquals("nunez", fold("ÑÚÑEZ"))
        assertEquals("obrien", fold("O'Brien"))
        assertEquals("3m crew", fold("3M  Crew "))
        assertEquals("ana ortiz", fold("Ana Ortiz"))
        assertEquals("", fold(null))
        assertEquals("", fold("'"))
        // Every Unicode number category stays: Arabic-Indic three (Nd), superscript two (No), ideographic zero (Nl).
        assertEquals("a٣²〇", fold("A٣²〇"))
    }

    @Test fun foldTreatsUnicodeSpacesAsSpaces() {
        // No-break space, ideographic space, line separator and NEL count as spaces, as on iOS.
        assertEquals("ana ortiz", fold("Ana Ortiz"))
        assertEquals("ana ortiz", fold(" Ana　 Ortiz\u0085"))
    }

    // ── sort and sections (Review Focus 1) ──────────────────────────

    @Test fun nunezSortsAndSectionsUnderN() {
        val sorted = sortRows(listOf(nunez, abbott, nash))
        assertEquals(listOf("Abbott", "Nash", "Núñez"), sorted.map { it.last_name })
        assertEquals("N", sectionLetter("Núñez"))
        assertEquals("N", sectionLetter("Ñúñez"))
        val n = sections(listOf(nunez, abbott, nash)).single { it.first == "N" }.second
        assertEquals(listOf("Nash", "Núñez"), n.map { it.last_name })
    }

    @Test fun deLaCruzSectionsUnderD() {
        assertEquals("D", sectionLetter("de la Cruz"))
        assertEquals(listOf(cruz), sections(listOf(cruz, abbott)).single { it.first == "D" }.second)
    }

    @Test fun threeMCrewSectionsUnderHashAfterZ() {
        assertEquals("#", sectionLetter("3M Crew"))
        assertEquals("#", sectionLetter(""))
        assertEquals("#", sectionLetter("'"))
        val letters = sections(listOf(crew, obrien, nunez, cruz, abbott, rigger, nash)).map { it.first }
        assertEquals(listOf("A", "D", "N", "O", "R", "#"), letters)
    }

    @Test fun sortBreaksTiesOnFirstNameThenPersonId() {
        val b = row("p-2", "Ben", "Smith")
        val a2 = row("p-9", "Al", "Smith")
        val a1 = row("p-1", "Al", "smith")
        assertEquals(listOf("p-1", "p-9", "p-2"), sortRows(listOf(b, a2, a1)).map { it.person_id })
    }

    @Test fun sectionsKeepSortedOrderInsideEachLetter() {
        val out = sections(listOf(rigger, nash, nunez, row("p-ross", "Ross", "Ray")))
        assertEquals(listOf("N" to listOf("Nash", "Núñez"), "R" to listOf("Ray", "Reed")), out.map { (k, v) -> k to v.map { it.last_name } })
    }

    // ── search (Review Focus 1) ─────────────────────────────────────

    @Test fun obrienFoundByObr() {
        assertTrue(matches(obrien, "obr"))
        assertTrue(matches(obrien, "O'Br"))
        assertFalse(matches(obrien, "brien"))
    }

    @Test fun deLaCruzFoundByCruz() {
        assertTrue(matches(cruz, "cruz"))
        assertTrue(matches(cruz, "mari cruz"))
        assertTrue(matches(cruz, "de la"))
    }

    @Test fun nunezFoundWithOrWithoutAccents() {
        assertTrue(matches(nunez, "nunez"))
        assertTrue(matches(nunez, "Núñ"))
        assertTrue(matches(nunez, "jose"))
    }

    @Test fun rigSumFindsARiggerAtSummitCrew() {
        assertTrue(matches(rigger, "rig sum"))
        assertTrue(matches(rigger, "  RIG   sum "))
        assertTrue(matches(rigger, "rig sum"))
        assertTrue(matches(rigger, "crew reed"))
        assertFalse(matches(rigger, "rig xyz"))
        assertFalse(matches(nunez, "rig"))
    }

    @Test fun hyphenatedNamesMatchWholeOrByPart() {
        val sj = row("p-sj", "Ann", "Smith-Jones")
        assertTrue(matches(sj, "smith-jones"))
        assertTrue(matches(sj, "Smith-J"))
        assertTrue(matches(sj, "smithjones"))
        assertTrue(matches(sj, "jones"))
        assertTrue(matches(sj, "smith"))
        assertFalse(matches(sj, "smith-brown"))
    }

    @Test fun emptyQueryMatchesAll() {
        val all = listOf(abbott, nunez, nash, obrien, cruz, crew, rigger)
        assertTrue(all.all { matches(it, "") })
        assertTrue(all.all { matches(it, "   ") })
    }

    // ── filters and counts ──────────────────────────────────────────

    @Test fun filtersByAllStatusAndNoPhoto() {
        val rows = listOf(abbott, nunez, nash, obrien)
        assertEquals(rows, applyFilter(rows, "all"))
        assertEquals(listOf(nunez, nash), applyFilter(rows, "active"))
        assertEquals(listOf(obrien), applyFilter(rows, "blacklist"))
        assertEquals(listOf(nash), applyFilter(rows, "no_photo"))
        assertEquals(emptyList<RolodexRow>(), applyFilter(rows, "unknown"))
    }

    @Test fun countsCoverAllEachStatusAndNoPhotoInOrder() {
        val counts = filterCounts(listOf(abbott, nunez, nash, obrien), listOf("active", "standby", "blacklist"))
        assertEquals(listOf("all", "active", "standby", "blacklist", "no_photo"), counts.keys.toList())
        assertEquals(mapOf("all" to 4, "active" to 2, "standby" to 1, "blacklist" to 1, "no_photo" to 1), counts)
        val searched = listOf(abbott, nunez, nash, obrien).filter { matches(it, "n") }
        assertEquals(mapOf("all" to 2, "active" to 2, "standby" to 0, "blacklist" to 0, "no_photo" to 1),
            filterCounts(searched, listOf("active", "standby", "blacklist")))
    }

    // ── edit: patch and validation ──────────────────────────────────

    private val detail = RolodexDetail(
        person_id = "p-reed", first_name = "Marcus", last_name = "Reed", preferred_name = null,
        display_name = "Marcus Reed", job_title = "Rigger", company = RolodexCompany("c1", "Summit Crew"),
        trade = "Rigging", level = "L2", level_color = "#64748B", status = "active", status_label = "Active",
        status_color = "#16A34A", has_photo = true, photo_url = "https://files.example/p.jpg", photo_version = "abcd",
        rfid_enrolled = true, has_account = false, email = "marcus@example.com", phone = "312-555-0142",
        external_id = "E-17", status_note = null, can_edit = true, can_change_status = true,
    )

    @Test fun editStartsFromTheDetail() {
        val e = RolodexEdit.from(detail)
        assertEquals("Marcus", e.firstName); assertEquals("", e.preferredName); assertEquals("c1", e.partnerId)
        assertEquals("L2", e.level); assertEquals("active", e.status); assertEquals("", e.statusNote)
        assertEquals("312-555-0142", e.phone)
    }

    @Test fun unchangedEditBuildsAnEmptyPatch() {
        assertEquals(JsonObject(emptyMap()), buildPatch(detail, RolodexEdit.from(detail)))
        // Whitespace around an unchanged value is not a change.
        assertEquals(JsonObject(emptyMap()), buildPatch(detail, RolodexEdit.from(detail).copy(jobTitle = "  Rigger ")))
    }

    @Test fun clearedPhoneSendsAnExplicitNull() {
        val patch = buildPatch(detail, RolodexEdit.from(detail).copy(phone = "  "))
        assertEquals(buildJsonObject { put("phone", JsonNull) }, patch)
        assertEquals("""{"phone":null}""", patch.toString())
    }

    @Test fun changedLevelOnlySendsTheLevel() {
        assertEquals(buildJsonObject { put("level", "L4") }, buildPatch(detail, RolodexEdit.from(detail).copy(level = "L4")))
    }

    @Test fun companyAndLevelCanBeClearedAndFilledFieldsAreTrimmed() {
        val patch = buildPatch(detail, RolodexEdit.from(detail).copy(partnerId = null, level = null, preferredName = " Marc "))
        assertEquals(buildJsonObject { put("preferred_name", "Marc"); put("partner_id", JsonNull); put("level", JsonNull) }, patch)
    }

    @Test fun blacklistSendsStatusAndNote() {
        val patch = buildPatch(detail, RolodexEdit.from(detail).copy(status = BLACKLIST_STATUS, statusNote = "No-show twice"))
        assertEquals(buildJsonObject { put("status", "blacklist"); put("status_note", "No-show twice") }, patch)
    }

    @Test fun aBlankStatusIsNeverSent() {
        assertEquals(JsonObject(emptyMap()), buildPatch(detail, RolodexEdit.from(detail).copy(status = "  ")))
        // A detail without a status reads as "" and so does its form.
        val noStatus = detail.copy(status = "")
        assertEquals("", RolodexEdit.from(noStatus).status)
        assertEquals(JsonObject(emptyMap()), buildPatch(noStatus, RolodexEdit.from(noStatus)))
    }

    @Test fun validateNeedsBothNames() {
        val ok = RolodexEdit.from(detail)
        assertNull(validate(ok))
        assertEquals("First and last name are required.", validate(ok.copy(firstName = " ")))
        assertEquals("First and last name are required.", validate(ok.copy(lastName = "")))
    }

    @Test fun validateNeedsANoteToBlacklist() {
        val ok = RolodexEdit.from(detail)
        assertEquals("Add a note to blacklist someone.", validate(ok.copy(status = "blacklist", statusNote = "  ")))
        assertNull(validate(ok.copy(status = "blacklist", statusNote = "No-show")))
        assertNull(validate(ok.copy(status = "standby")))
    }

    /** The server's 422 for a malformed email carries no code, so the form catches it first. */
    @Test fun validateRefusesAnEmailThatIsntNameAtDomain() {
        val ok = RolodexEdit.from(detail)
        val bad = "Enter a valid email address."
        assertNull(validate(ok.copy(email = "ana@example.com")))
        assertNull(validate(ok.copy(email = " ana@example.com ")))          // sent trimmed
        assertNull(validate(ok.copy(email = "")))                           // blank clears it
        assertNull(validate(ok.copy(email = "  ")))
        assertEquals(bad, validate(ok.copy(email = "ana@example")))
        assertEquals(bad, validate(ok.copy(email = "ana example@x.com")))
        assertEquals(bad, validate(ok.copy(email = "@x.com")))
        assertEquals(bad, validate(ok.copy(email = "ana@@x.com")))
        assertEquals(bad, validate(ok.copy(email = "ana@x@y.com")))
        assertEquals(bad, validate(ok.copy(email = "ana@.com")))
        assertEquals(bad, validate(ok.copy(email = "ana@x.")))
        assertEquals(bad, validate(ok.copy(email = "ana@")))
    }

    /** Names first, then the email, then the blacklist note. */
    @Test fun validateReportsTheFirstProblemInFormOrder() {
        val ok = RolodexEdit.from(detail)
        val all = ok.copy(firstName = "", email = "nope", status = "blacklist", statusNote = "")
        assertEquals("First and last name are required.", validate(all))
        assertEquals("Enter a valid email address.", validate(all.copy(firstName = "Ana")))
        assertEquals("Add a note to blacklist someone.", validate(all.copy(firstName = "Ana", email = "ana@example.com")))
    }
}
