package com.serversherpa.kiosk.core.troubleshooting

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** One guide in topics.json; [doc] is its wiki document's file name in the same folder. */
@Serializable
data class Topic(val id: String, val title: String, val blurb: String, val doc: String)

@Serializable
data class Mark(val type: String)

/** A node of the wiki's ProseMirror JSON (kiosk/src/troubleshooting/WikiDoc.tsx DocNode). */
@Serializable
data class DocNode(
    val type: String,
    val attrs: JsonObject? = null,
    val content: List<DocNode> = emptyList(),
    val text: String? = null,
    val marks: List<Mark> = emptyList(),
)

/** Parsing for the bundled guides' JSON; unknown keys are ignored. Loading lives in
 *  data/troubleshooting (core/ stays free of Android). */
object TroubleshootingJson {
    private val json = Json { ignoreUnknownKeys = true }

    fun topics(text: String): List<Topic> = json.decodeFromString(text)

    fun doc(text: String): DocNode = json.decodeFromString(text)

    /** A name inside the guides' folder: a doc's assetId never reaches outside it. */
    fun isPlainFileName(file: String): Boolean = file.isNotEmpty() && '/' !in file && '\\' !in file && file != "." && file != ".."
}
