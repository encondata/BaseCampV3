package com.serversherpa.kiosk.core.people

import com.serversherpa.kiosk.core.model.RolodexDetail
import com.serversherpa.kiosk.core.model.RolodexRow
import java.text.Normalizer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// The Rolodex list rules (plan "Shared client logic"); the iOS app's RolodexLogic mirrors them exactly.

/** The worker status that needs a note. */
const val BLACKLIST_STATUS = "blacklist"

/** The filter that shows everyone, and the one that shows workers without a photo. */
const val FILTER_ALL = "all"
const val FILTER_NO_PHOTO = "no_photo"

/** Section key for last names that don't start with a–z. Its section comes after Z. */
const val OTHER_SECTION = "#"

// Unicode whitespace (a no-break space too), as on iOS, spelled out as \s plus \p{Z} and NEL:
// Android's ICU regex engine rejects the (?U) flag that would say it (PatternSyntaxException).
private val COMBINING_MARKS = Regex("\\p{M}+")
private val NOT_LETTER_DIGIT_OR_SPACE = Regex("[^\\p{L}\\p{N}\\s\\p{Z}\\u0085]+")
private val SPACES = Regex("[\\s\\p{Z}\\u0085]+")
private val HYPHENS = Regex("-+")

/**
 * Lowercase, accents stripped (`Núñez` → `nunez`), and every character that isn't a letter, digit
 * or space dropped (`O'Brien` → `obrien`); runs of spaces collapse to one and the ends are trimmed.
 */
fun fold(s: String?): String {
    if (s.isNullOrEmpty()) return ""
    val bare = Normalizer.normalize(s, Normalizer.Form.NFD).replace(COMBINING_MARKS, "")
    return bare.lowercase().replace(NOT_LETTER_DIGIT_OR_SPACE, "").replace(SPACES, " ").trim()
}

/** What [sortRows] orders by: folded last name, then folded first name, then person id. */
data class RolodexSortKey(val last: String, val first: String, val id: String) : Comparable<RolodexSortKey> {
    override fun compareTo(other: RolodexSortKey): Int = compareValuesBy(this, other, { it.last }, { it.first }, { it.id })
}

/** A row's [RolodexSortKey]. A list that keeps it per row can re-sort without folding the names again. */
fun sortKey(row: RolodexRow): RolodexSortKey = RolodexSortKey(fold(row.last_name), fold(row.first_name), row.person_id)

/**
 * By folded last name, then folded first name, then person id. Each row's names are folded once
 * (decorate, sort, undecorate), not on every comparison.
 */
fun sortRows(rows: List<RolodexRow>): List<RolodexRow> =
    rows.map { sortKey(it) to it }.sortedBy { it.first }.map { it.second }

/** The folded last name's first character uppercased when it is a–z, else [OTHER_SECTION]: `de la Cruz` → D, `3M Crew` → #. */
fun sectionLetter(lastName: String): String {
    val c = fold(lastName).firstOrNull() ?: return OTHER_SECTION
    return if (c in 'a'..'z') c.uppercaseChar().toString() else OTHER_SECTION
}

/** Sorted rows grouped by [sectionLetter]: A–Z in order, then [OTHER_SECTION] last. Empty letters are left out. */
fun sections(rows: List<RolodexRow>): List<Pair<String, List<RolodexRow>>> =
    groupSections(sortRows(rows)) { sectionLetter(it.last_name) }

/**
 * Already-sorted items grouped by a letter worked out beforehand (the screen keeps each row's
 * [sectionLetter]), in the order of [sections]: A–Z, then [OTHER_SECTION] last. Each group keeps
 * the items' order.
 */
fun <T> groupSections(sorted: List<T>, letterOf: (T) -> String): List<Pair<String, List<T>>> {
    val groups = sorted.groupBy(letterOf)
    return groups.keys.sortedWith(compareBy<String>({ it == OTHER_SECTION }, { it })).map { it to groups.getValue(it) }
}

/**
 * The searchable words of a row's first, last and preferred name, job title and company, folded:
 * each whitespace word whole, plus its hyphen parts ("Smith-Jones" → smithjones, smith, jones).
 * A list screen works these out once per row and keeps them, so typing never folds the list again.
 */
fun searchWords(row: RolodexRow): List<String> =
    listOf(row.first_name, row.last_name, row.preferred_name, row.job_title, row.company?.name)
        .flatMap { (it ?: "").split(SPACES) }
        .flatMap { word -> listOf(word) + word.split(HYPHENS) }
        .map(::fold)
        .filter { it.isNotEmpty() }
        .distinct()

/** The query's whitespace-separated terms, folded; terms that fold to nothing are dropped. */
fun queryTerms(query: String): List<String> = query.split(SPACES).map(::fold).filter { it.isNotEmpty() }

/** Every term is a prefix of at least one of [words]; no terms match everyone. */
fun matchesTerms(words: List<String>, terms: List<String>): Boolean =
    terms.all { term -> words.any { it.startsWith(term) } }

/**
 * Every whitespace-separated query term (folded; terms that fold to nothing are dropped) must be a
 * prefix of at least one [searchWords] word, so "smith-jones", "smith" and "jones" all find Smith-Jones.
 * An empty query matches everyone.
 */
fun matches(row: RolodexRow, query: String): Boolean {
    val terms = queryTerms(query)
    return terms.isEmpty() || matchesTerms(searchWords(row), terms)
}

/** Whether [row] shows under [filter]: [FILTER_ALL], [FILTER_NO_PHOTO] (`has_photo == false`), or a status key. */
fun passesFilter(row: RolodexRow, filter: String): Boolean = when (filter) {
    FILTER_ALL -> true
    FILTER_NO_PHOTO -> !row.has_photo
    else -> row.status == filter
}

/** The rows that pass [filter] ([passesFilter]). */
fun applyFilter(rows: List<RolodexRow>, filter: String): List<RolodexRow> =
    if (filter == FILTER_ALL) rows else rows.filter { passesFilter(it, filter) }

/**
 * The chip counts, in chip order: all, one per status key, no_photo. Pass the search-filtered
 * rows, so the counts follow the search.
 */
fun filterCounts(rows: List<RolodexRow>, statusKeys: List<String>): Map<String, Int> {
    val out = LinkedHashMap<String, Int>()
    out[FILTER_ALL] = rows.size
    for (key in statusKeys) out[key] = rows.count { it.status == key }
    out[FILTER_NO_PHOTO] = rows.count { !it.has_photo }
    return out
}

/**
 * The worker page's Edit form. Text fields are as typed ("" is empty); [partnerId] and [level]
 * are picker values (null is None). [status] is a status key; [statusNote] matters for Blacklist.
 */
data class RolodexEdit(
    val firstName: String = "",
    val lastName: String = "",
    val preferredName: String = "",
    val jobTitle: String = "",
    val phone: String = "",
    val email: String = "",
    val partnerId: String? = null,
    val trade: String = "",
    val level: String? = null,
    val status: String = "",
    val statusNote: String = "",
) {
    companion object {
        /** The form as it opens: the worker's current values. */
        fun from(d: RolodexDetail) = RolodexEdit(
            firstName = d.first_name, lastName = d.last_name, preferredName = d.preferred_name ?: "",
            jobTitle = d.job_title ?: "", phone = d.phone ?: "", email = d.email ?: "",
            partnerId = d.company?.id, trade = d.trade ?: "", level = d.level,
            status = d.status, statusNote = d.status_note ?: "",
        )
    }
}

/** Trimmed, with blank as null: how both sides of a comparison and the sent value are read. */
private fun clean(s: String?): String? = s?.trim()?.takeIf { it.isNotEmpty() }

/**
 * The PATCH body: only the fields that changed (compared trimmed, blank = empty), a cleared field
 * as an explicit `null`. Nothing changed → `{}`. A blank status is never sent (status can't be cleared).
 */
fun buildPatch(original: RolodexDetail, edited: RolodexEdit): JsonObject = buildJsonObject {
    fun field(key: String, before: String?, after: String?) {
        val a = clean(after)
        if (clean(before) != a) put(key, if (a == null) JsonNull else JsonPrimitive(a))
    }
    field("first_name", original.first_name, edited.firstName)
    field("last_name", original.last_name, edited.lastName)
    field("preferred_name", original.preferred_name, edited.preferredName)
    field("job_title", original.job_title, edited.jobTitle)
    field("phone", original.phone, edited.phone)
    field("email", original.email, edited.email)
    field("partner_id", original.company?.id, edited.partnerId)
    field("trade", original.trade, edited.trade)
    field("level", original.level, edited.level)
    if (clean(edited.status) != null) field("status", original.status, edited.status)
    field("status_note", original.status_note, edited.statusNote)
}

/**
 * name@domain.tld: no whitespace, exactly one @, something before it, and a domain of dot-separated
 * labels with at least one dot and no empty label. The server's own check is stricter; this one
 * only keeps its codeless 422 (shown as "Something went wrong.") off the form.
 */
private val EMAIL = Regex("^[^\\s@]+@[^\\s@.]+(\\.[^\\s@.]+)+$")

/** Whether a typed email (trimmed, as it is sent) looks like name@domain.tld. */
fun looksLikeEmail(email: String): Boolean = EMAIL.matches(email.trim())

/**
 * The first problem with the form, in the spec's words, or null when it can be saved. In form
 * order: the names, then the email (blank is fine: it clears it), then the Blacklist note.
 */
fun validate(edit: RolodexEdit): String? = when {
    edit.firstName.isBlank() || edit.lastName.isBlank() -> "First and last name are required."
    edit.email.isNotBlank() && !looksLikeEmail(edit.email) -> "Enter a valid email address."
    edit.status.trim() == BLACKLIST_STATUS && edit.statusNote.isBlank() -> "Add a note to blacklist someone."
    else -> null
}
