package com.serversherpa.kiosk.core.people

import com.serversherpa.kiosk.core.scan.displayRfid

interface MatchPerson {
    val id: String
    val displayName: String
    val firstName: String?
    val lastName: String?
    val preferredName: String?
    val rfidTag: String?
    val isWorker: Boolean
    val hasAccount: Boolean
}

internal class Entry<P : MatchPerson>(val person: P, val parts: List<String>, val fullNames: List<String>, val sortKey: String)

class PeopleIndex<P : MatchPerson> internal constructor(
    val byRfid: Map<String, P>,
    /** Full id and the eight-character short id, both lower-cased. */
    val byId: Map<String, P>,
    private val entries: List<Entry<P>>,
    val size: Int,
) {
    internal fun entries() = entries
}

private val SHORT_ID = Regex("^[0-9a-f]{8}$", RegexOption.IGNORE_CASE)

/** Whitespace or a hyphen starts a new part ("Smith-Jones" → smith, jones). */
private fun words(value: String?): List<String> =
    (value ?: "").trim().lowercase().split(Regex("[\\s-]+")).filter { it.isNotEmpty() }

private fun rfidKey(value: String?): String? {
    if (value.isNullOrBlank()) return null
    return displayRfid(value.trim()).uppercase().takeIf { it.isNotEmpty() }
}

private fun <P : MatchPerson> entryFor(person: P): Entry<P> {
    val parts = ArrayList<String>()
    fun push(w: String) { if (w.isNotEmpty() && w !in parts) parts.add(w) }
    for (source in listOf(person.firstName, person.lastName, person.preferredName)) words(source).forEach(::push)
    words(person.displayName).forEach(::push)

    val first = (person.firstName ?: "").trim().lowercase()
    val last = (person.lastName ?: "").trim().lowercase()
    val preferred = (person.preferredName ?: "").trim().lowercase()
    val fullNames = ArrayList<String>()
    fun pushFull(name: String) {
        val collapsed = name.trim().replace(Regex("\\s+"), " ")
        if (collapsed.isNotEmpty() && collapsed !in fullNames) fullNames.add(collapsed)
    }
    pushFull(person.displayName.lowercase())
    if (first.isNotEmpty() && last.isNotEmpty()) pushFull("$first $last")
    if (preferred.isNotEmpty() && last.isNotEmpty()) pushFull("$preferred $last")
    return Entry(person, parts, fullNames, person.displayName.lowercase())
}

fun <P : MatchPerson> buildPeopleIndex(people: List<P>): PeopleIndex<P> {
    val byRfid = LinkedHashMap<String, P>()
    val byId = LinkedHashMap<String, P>()
    val entries = ArrayList<Entry<P>>(people.size)
    for (person in people) {
        rfidKey(person.rfidTag)?.let { byRfid.putIfAbsent(it, person) }
        val id = person.id.trim().lowercase()
        if (id.isNotEmpty()) byId.putIfAbsent(id, person)
        val short = id.take(8)
        if (short.length == 8) byId.putIfAbsent(short, person)
        entries.add(entryFor(person))
    }
    return PeopleIndex(byRfid, byId, entries, people.size)
}

/** The badge/id door: a value naming exactly one person, or null. */
fun <P : MatchPerson> matchPersonExact(index: PeopleIndex<P>, raw: String): P? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    rfidKey(trimmed)?.let { index.byRfid[it] }?.let { return it }
    val lower = trimmed.lowercase()
    val byId = index.byId[lower] ?: return null
    // The eight-character short form only counts when it looks like hex.
    return if (lower.length != 8 || SHORT_ID.matches(lower)) byId else null
}

/** True when `raw` is an exact tag AND a strict prefix of a longer tag
 *  ("1003" vs "100348") — too soon to auto-select mid-scan. */
fun <P : MatchPerson> isAmbiguousPrefix(index: PeopleIndex<P>, raw: String): Boolean {
    val tag = rfidKey(raw.trim()) ?: return false
    if (!index.byRfid.containsKey(tag)) return false
    return index.byRfid.keys.any { it != tag && it.startsWith(tag) }
}

/** Every term is a prefix of a distinct part — a tiny bipartite match. */
private fun assign(terms: List<String>, parts: List<String>): Boolean {
    if (terms.size > parts.size) return false
    val used = BooleanArray(parts.size)
    fun go(i: Int): Boolean {
        if (i == terms.size) return true
        for (j in parts.indices) {
            if (used[j] || !parts[j].startsWith(terms[i])) continue
            used[j] = true
            if (go(i + 1)) return true
            used[j] = false
        }
        return false
    }
    return go(0)
}

/** The typed-name door: full-name matches first, then fewest name parts, then alphabetical. */
fun <P : MatchPerson> searchPeople(index: PeopleIndex<P>, query: String, limit: Int = 8): List<P> {
    val terms = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (terms.isEmpty()) return emptyList()
    val typed = terms.joinToString(" ")
    return index.entries()
        .filter { assign(terms, it.parts) }
        .sortedWith(
            compareBy<Entry<P>> { if (typed in it.fullNames) 0 else 1 }
                .thenBy { it.parts.size }
                .thenBy { it.sortKey },
        )
        .take(limit)
        .map { it.person }
}
