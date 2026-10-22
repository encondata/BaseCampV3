package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.serversherpa.kiosk.core.model.RolodexMatch
import com.serversherpa.kiosk.core.model.RolodexOptions
import com.serversherpa.kiosk.core.people.RolodexEdit
import com.serversherpa.kiosk.input.camera.PhotoCaptureSheet
import com.serversherpa.kiosk.input.camera.PhotoStepsWindow
import com.serversherpa.kiosk.input.camera.rememberPhotoPicker
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** The page width from which phone and email pair up on the details step. */
private val PAIR_WIDTH = 440.dp

/** The company picker on a new worker: None, then the non-archived partners. */
internal fun newCompanyChoices(options: RolodexOptions): List<Pair<String?, String>> =
    listOf<Pair<String?, String>>(null to "None") + options.partners.map { it.id to it.name }

/** The level picker on a new worker: None, then the scale ("L3 · Lead"). Level starts empty (spec §3.19). */
internal fun newLevelChoices(options: RolodexOptions): List<Pair<String?, String>> =
    listOf<Pair<String?, String>>(null to "None") + options.levels.map { it.level to (if (it.title.isBlank()) it.level else "${it.level} · ${it.title}") }

/**
 * "+ New" (mockups 3–4). The details (Step 1 of 2) fill the Rolodex page, inside the shell; the
 * photo step and "Position your photo" open full screen over it; the "Possible duplicate" sheet
 * and the "Create … without a photo?" confirmation open over whichever step asked. Every bit of
 * state is in [NewWorkerFlow].
 */
@Composable
internal fun NewWorkerScreen(vm: RolodexViewModel, flow: NewWorkerUi, options: RolodexOptions, hasCamera: Boolean, modifier: Modifier = Modifier) {
    val nw = vm.newWorker
    val context = LocalContext.current.applicationContext
    val pick = rememberPhotoPicker { uri -> nw.usePhoto { decodeForCrop(context, uri) } }

    NewWorkerDetails(nw, flow, options, modifier)

    if (flow.stage != NewWorkerStage.DETAILS) {
        PhotoStepsWindow(onBack = { if (flow.stage == NewWorkerStage.CROP) nw.retake() else nw.backToDetails() }) { insets ->
            val crop = flow.crop
            if (flow.stage == NewWorkerStage.CROP && crop != null) {
                PhotoCropScreen(
                    crop, useLabel = "Create worker", busyText = flow.busyText, errorText = flow.error,
                    onRetake = nw::retake, onUse = nw::createWithPhoto, insets = insets,
                )
            } else {
                PhotoCaptureSheet(
                    backLabel = "‹ Details", onBack = nw::backToDetails, hasCamera = hasCamera, busyText = flow.busyText,
                    errorText = flow.error, onCapture = { bytes -> nw.usePhoto { decodeForCrop(bytes) } }, onLibrary = pick, insets = insets,
                ) {
                    Text(
                        "Continue without photo", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium,
                        color = Color.White.copy(alpha = 0.75f), textDecoration = TextDecoration.Underline,
                        modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = !flow.busy, role = Role.Button, onClick = nw::continueWithoutPhoto)
                            .heightIn(min = 44.dp).padding(horizontal = 12.dp, vertical = 12.dp).alpha(if (flow.busy) 0.45f else 1f)
                            .testTag("new-worker-skip-photo"),
                    )
                }
            }
        }
    }

    if (flow.showMatches) DuplicateSheet(nw, flow)

    if (flow.confirmNoPhoto) {
        // The default (the right-hand, bold choice) goes back to the camera.
        AlertDialog(
            onDismissRequest = nw::takePhotoInstead,
            title = { Text(flow.confirmTitle) },
            text = { Text(NO_PHOTO_MESSAGE) },
            confirmButton = {
                TextButton(onClick = nw::takePhotoInstead, modifier = Modifier.testTag("confirm-take-photo")) {
                    Text("Take photo", fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = nw::createWithoutPhoto, modifier = Modifier.testTag("confirm-create-without-photo")) { Text("Create without photo") }
            },
        )
    }
}

/**
 * Step 1 of 2: first and last name (required), preferred name, job title, phone, email, company,
 * trade and level. A new worker starts Active (status isn't on this form). The fields keep their
 * own text and hand every change to the flow, as the Edit form does.
 */
@Composable
private fun NewWorkerDetails(nw: NewWorkerFlow, flow: NewWorkerUi, options: RolodexOptions, modifier: Modifier) {
    val c = LocalKioskColors.current
    var form by remember { mutableStateOf(flow.form) }
    var picker by remember { mutableStateOf<String?>(null) }
    val off = flow.busy
    fun change(next: RolodexEdit) { form = next; nw.update(next) }
    val companies = newCompanyChoices(options)
    val levels = newLevelChoices(options)

    Column(modifier) {
        Box(Modifier.align(Alignment.CenterHorizontally).widthIn(max = 720.dp).fillMaxWidth().heightIn(min = 52.dp)) {
            TextButton(onClick = nw::cancel, enabled = !flow.creating, modifier = Modifier.align(Alignment.CenterStart).heightIn(min = 48.dp).testTag("new-worker-cancel")) {
                Text("Cancel", color = c.accent, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
            }
            Text(
                "New worker", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = c.textDark,
                modifier = Modifier.align(Alignment.Center).semantics { heading() },
            )
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val pairUp = maxWidth >= PAIR_WIDTH
            Column(
                Modifier.align(Alignment.TopCenter).widthIn(max = 720.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 12.dp),
            ) {
                Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.weight(1f).height(4.dp).background(c.accent, RoundedCornerShape(2.dp)))
                    Box(Modifier.weight(1f).height(4.dp).background(c.paperLine, RoundedCornerShape(2.dp)))
                }
                Text(
                    "Step 1 of 2 · Details".uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textMute,
                    modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
                )
                val pair = Modifier.fillMaxWidth().padding(top = 8.dp)
                Row(pair, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextBox("First name *", form.firstName, off, "new-first", Modifier.weight(1f), words = true) { change(form.copy(firstName = it)) }
                    TextBox("Last name *", form.lastName, off, "new-last", Modifier.weight(1f), words = true) { change(form.copy(lastName = it)) }
                }
                TextBox("Preferred name", form.preferredName, off, "new-preferred", pair, words = true) { change(form.copy(preferredName = it)) }
                TextBox("Job title", form.jobTitle, off, "new-job", pair, words = true) { change(form.copy(jobTitle = it)) }
                if (pairUp) {
                    Row(pair, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextBox("Phone", form.phone, off, "new-phone", Modifier.weight(1f), keyboard = KeyboardType.Phone) { change(form.copy(phone = it)) }
                        TextBox("Email", form.email, off, "new-email", Modifier.weight(1f), keyboard = KeyboardType.Email) { change(form.copy(email = it)) }
                    }
                } else {
                    TextBox("Phone", form.phone, off, "new-phone", pair, keyboard = KeyboardType.Phone) { change(form.copy(phone = it)) }
                    TextBox("Email", form.email, off, "new-email", pair, keyboard = KeyboardType.Email) { change(form.copy(email = it)) }
                }
                val company = companies.firstOrNull { it.first != null && it.first == form.partnerId }?.second
                PickBox("Company", company ?: "Choose a company", off, "new-company", pair, hint = company == null) { picker = "company" }
                Row(pair, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextBox("Trade", form.trade, off, "new-trade", Modifier.weight(1f), words = true) { change(form.copy(trade = it)) }
                    val level = levels.firstOrNull { it.first != null && it.first == form.level }?.second
                    PickBox("Level", level ?: "Choose a level", off, "new-level", Modifier.weight(1f), hint = level == null) { picker = "level" }
                }
            }
        }
        Column(Modifier.align(Alignment.CenterHorizontally).widthIn(max = 720.dp).fillMaxWidth().padding(top = 4.dp, bottom = 8.dp)) {
            if (flow.stage == NewWorkerStage.DETAILS) KioskToast(flow.error, error = true)
            SolidButton(
                if (flow.checking) "Checking…" else "Next: photo", onClick = nw::next, enabled = !flow.busy,
                modifier = Modifier.fillMaxWidth().testTag("new-worker-next"),
            )
        }
    }

    when (picker) {
        "company" -> PickerDialog("Company", companies, form.partnerId, onPick = { change(form.copy(partnerId = it)); picker = null }, onDismiss = { picker = null })
        "level" -> PickerDialog("Level", levels, form.level, onPick = { change(form.copy(level = it)); picker = null }, onDismiss = { picker = null })
    }
}

/**
 * "Possible duplicate": the people the new worker may already be, each with photo, name, job
 * title and company. A worker has Open; anyone else is "Already in the portal, not a worker. Add
 * the worker role there." An email match blocks Create anyway (the email can't be reused).
 */
@Composable
private fun DuplicateSheet(nw: NewWorkerFlow, flow: NewWorkerUi) {
    val c = LocalKioskColors.current
    Dialog(onDismissRequest = { if (!flow.busy) nw.dismissMatches() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
            Column(
                Modifier.widthIn(max = 640.dp).fillMaxWidth().heightIn(max = 640.dp).background(c.paper, RoundedCornerShape(16.dp)).padding(16.dp),
            ) {
                Text("New worker".uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textMute)
                Text(
                    "Possible duplicate", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, color = c.textDark,
                    modifier = Modifier.padding(top = 2.dp, bottom = 12.dp).semantics { heading() },
                )
                Column(
                    Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).clip(RoundedCornerShape(14.dp))
                        .background(c.paper2).border(1.dp, c.paperLine, RoundedCornerShape(14.dp)),
                ) {
                    flow.matches.forEachIndexed { i, match ->
                        if (i > 0) Spacer(Modifier.fillMaxWidth().height(1.dp).background(c.paperLine))
                        MatchRow(match, enabled = !flow.busy) { nw.openMatch(match.person_id) }
                    }
                }
                KioskToast(flow.blockText, error = true)
                if (flow.error != null && flow.stage != NewWorkerStage.DETAILS) KioskToast(flow.error, error = true)
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    MiniButton("Back", onClick = nw::dismissMatches, enabled = !flow.busy, modifier = Modifier.testTag("duplicate-back"))
                    Spacer(Modifier.weight(1f))
                    SolidButton(
                        if (flow.creating) "Creating…" else "Create anyway", onClick = nw::createAnyway,
                        enabled = flow.canCreateAnyway && !flow.busy, modifier = Modifier.testTag("duplicate-create-anyway"),
                    )
                }
            }
        }
    }
}

@Composable
private fun MatchRow(match: RolodexMatch, enabled: Boolean, onOpen: () -> Unit) {
    val c = LocalKioskColors.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        WorkerAvatar(match.person_id, match.display_name, match.photo_url, match.photo_version, 44.dp)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(match.display_name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = c.textDark, maxLines = 1, overflow = TextOverflow.Ellipsis)
            matchSubtitle(match)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            matchNote(match)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 2.dp)) }
        }
        if (canOpen(match)) MiniButton("Open", onClick = onOpen, enabled = enabled, modifier = Modifier.testTag("duplicate-open-${match.person_id}"))
    }
}
