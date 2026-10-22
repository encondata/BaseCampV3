package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.core.model.RolodexDetail
import com.serversherpa.kiosk.core.people.BLACKLIST_STATUS
import com.serversherpa.kiosk.core.people.RolodexEdit
import com.serversherpa.kiosk.core.people.fold
import com.serversherpa.kiosk.core.people.matchesTerms
import com.serversherpa.kiosk.core.people.queryTerms
import com.serversherpa.kiosk.input.camera.PhotoCaptureSheet
import com.serversherpa.kiosk.input.camera.PhotoStepBar
import com.serversherpa.kiosk.input.camera.PhotoStepsWindow
import com.serversherpa.kiosk.input.camera.rememberPhotoPicker
import com.serversherpa.kiosk.ui.components.CameraIcon
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.lineIcon
import com.serversherpa.kiosk.ui.screens.timeclock.screens.TcChevronIcon
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** Why Edit is off for a worker whose portal login outranks the admin (spec §4.2). */
private const val EDIT_BLOCKED = "This person has a portal login ranked above yours."

/** Why the status control is off: yourself, or someone the admin can't touch. */
private fun statusBlockedText(reason: String?): String =
    if (reason == "self") "You can't change your own status." else EDIT_BLOCKED

/**
 * The selected worker's page (mockup 4-photo-required-and-worker-page): the photo with its camera
 * badge, name, "job title · company", status and RFID chips, then the Contact and Work cards. Edit
 * switches the cards to fields. Before the page loads, and offline, it shows what the list row
 * knows. [onBack] is the phone's "‹ Rolodex" (null in the split view); [onPhoto] opens the photo
 * sheet ([WorkerPhotoScreens]). The badge is off without it, when the worker can't be edited, and
 * offline (spec §3.17). A new worker whose photo didn't upload gets the failure box with Try again.
 */
@Composable
internal fun WorkerPage(
    ui: RolodexUi,
    vm: RolodexViewModel,
    wide: Boolean,
    onBack: (() -> Unit)?,
    onPhoto: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val detail = ui.detail
    val editing = ui.editing
    BoxWithConstraints(modifier) {
        // A split's page beside the list can be narrow (a 600 dp window leaves it about 200 dp):
        // the side-by-side header and paired fields need room, else it lays out as on a phone.
        val roomy = wide && maxWidth >= ROOMY_PAGE_WIDTH
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            if (editing != null && detail != null) EditForm(ui, detail, editing, vm, roomy)
            else WorkerView(ui, vm, roomy, onBack, onPhoto)
        }
    }
}

/** The page width from which the header sits in one row and phone and email pair up. */
private val ROOMY_PAGE_WIDTH = 440.dp

@Composable
private fun ColumnScope.WorkerView(ui: RolodexUi, vm: RolodexViewModel, wide: Boolean, onBack: (() -> Unit)?, onPhoto: (() -> Unit)?) {
    val c = LocalKioskColors.current
    val detail = ui.detail
    val row = ui.selectedRow
    val personId = ui.selectedId ?: return
    val name = detail?.display_name ?: row?.display_name.orEmpty()
    val canEdit = detail?.can_edit == true && !ui.offline
    val editButton = @Composable {
        MiniButton("Edit", onClick = vm::startEdit, enabled = canEdit, modifier = Modifier.testTag("worker-edit"))
    }
    val photo = @Composable { size: Dp ->
        PhotoWithBadge(
            personId, name, detail?.photo_url ?: row?.photo_url, detail?.photo_version ?: row?.photo_version, size,
            badgeEnabled = onPhoto != null && canEdit, onPhoto = { onPhoto?.invoke() },
        )
    }
    val words = @Composable { align: Alignment.Horizontal, textAlign: TextAlign ->
        Column(horizontalAlignment = align) {
            Text(
                name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, color = c.textDark,
                textAlign = textAlign, modifier = Modifier.testTag("worker-name"),
            )
            workLine(detail?.job_title ?: row?.job_title, (detail?.company ?: row?.company)?.name)?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textMute, textAlign = textAlign, modifier = Modifier.padding(top = 2.dp))
            }
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                val label = detail?.status_label ?: row?.status_label
                if (!label.isNullOrBlank()) ColorChip(label, hexColor(detail?.status_color ?: row?.status_color))
                if (detail?.rfid_enrolled ?: row?.rfid_enrolled == true) ColorChip("RFID enrolled", ChipTone.BLUE.text)
            }
        }
    }

    if (wide) {
        Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            photo(84.dp)
            Box(Modifier.weight(1f).padding(horizontal = 16.dp)) { words(Alignment.Start, TextAlign.Start) }
            editButton()
        }
    } else {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) {
                TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Back to the Rolodex list" }) {
                    Text("‹ Rolodex", color = c.accent, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
                }
            }
            Spacer(Modifier.weight(1f))
            editButton()
        }
        Column(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            photo(116.dp)
            Spacer(Modifier.height(12.dp))
            words(Alignment.CenterHorizontally, TextAlign.Center)
        }
    }

    // Why Edit is off, in the spec's words.
    val reason = when {
        detail != null && !detail.can_edit -> EDIT_BLOCKED
        ui.offline -> "Changes need a connection."
        else -> null
    }
    reason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.fillMaxWidth().padding(top = 4.dp), textAlign = if (wide) TextAlign.Start else TextAlign.Center) }
    if (ui.error != null) {
        KioskToast(ui.error, error = true)
        if (detail == null && !ui.detailLoading) MiniButton("Try again", onClick = { vm.select(personId) })
    }
    // A new worker whose photo didn't upload after the create (spec §3.6).
    val photoUi by vm.photos.state.collectAsStateWithLifecycle()
    photoUi.failures[personId]?.let { failure -> PhotoRetry(failure, offline = ui.offline) { vm.retryPhoto(personId) } }

    InfoCard("Contact") {
        if (detail == null) {
            Text(
                if (ui.detailLoading) "Loading…" else "Phone and email need a connection.",
                style = MaterialTheme.typography.bodyMedium, color = c.textMute, modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            )
        } else {
            Field("Preferred name", detail.preferred_name)
            Field("Phone", detail.phone)
            Field("Email", detail.email)
        }
    }
    InfoCard("Work") {
        Field("Company", (detail?.company ?: row?.company)?.name)
        val trade = detail?.trade ?: row?.trade
        val level = detail?.level ?: row?.level
        Field("Trade · Level", listOfNotNull(trade?.takeIf { it.isNotBlank() }, level).joinToString(" · ").ifEmpty { null })
        if (detail != null) Field("Employee ID", detail.external_id, mono = true)
        detail?.status_note?.takeIf { it.isNotBlank() }?.let { Field("Status note", it) }
    }
}

/**
 * "Marcus Reed was saved, but the photo didn't upload." with Try again (the same photo), and why
 * the last try failed. Try again needs a connection (spec §3.15).
 */
@Composable
private fun PhotoRetry(failure: PhotoFailure, offline: Boolean, onRetry: () -> Unit) {
    val c = LocalKioskColors.current
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp).background(ChipTone.RED.bg, RoundedCornerShape(10.dp))
            .border(1.dp, ChipTone.RED.border, RoundedCornerShape(10.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            photoFailureText(failure.name), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
            color = if (c.isDark) c.textDark else lerp(ChipTone.RED.text, Color.Black, 0.3f), modifier = Modifier.testTag("photo-failed"),
        )
        failure.retryError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute) }
        if (offline) Text("Changes need a connection.", style = MaterialTheme.typography.bodySmall, color = c.textMute)
        MiniButton(
            if (failure.retrying) "Uploading…" else "Try again", onClick = onRetry, enabled = !failure.retrying && !offline,
            borderColor = ChipTone.RED.border, modifier = Modifier.testTag("photo-retry"),
        )
    }
}

/**
 * The camera badge's screens (mockup 4): "Photo for Ana Ortiz" (Take new photo when the device has
 * a camera, Choose photo, Cancel), then the camera or the library, "Position your photo", and Use
 * photo. Every bit of state is in [RolodexPhotoFlow].
 */
@Composable
internal fun WorkerPhotoScreens(vm: RolodexViewModel, hasCamera: Boolean) {
    val c = LocalKioskColors.current
    val photos = vm.photos
    val ui by photos.state.collectAsStateWithLifecycle()
    val context = LocalContext.current.applicationContext
    val pick = rememberPhotoPicker { uri -> photos.use { decodeForCrop(context, uri) } }
    val target = ui.target ?: return

    if (ui.sheet) {
        Dialog(onDismissRequest = photos::close) {
            Column(Modifier.fillMaxWidth().background(c.paper, RoundedCornerShape(16.dp)).padding(vertical = 12.dp)) {
                Text(
                    "Photo for ${target.name}", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = c.textDark,
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 8.dp).semantics { heading() },
                )
                if (hasCamera) SheetOption(CameraIcon, "Take new photo", "photo-take", photos::takePhoto)
                SheetOption(PictureIcon, "Choose photo", "photo-library") { photos.closeSheet(); pick() }
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = photos::close, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel", color = c.accent, fontWeight = FontWeight.SemiBold) }
                }
            }
        }
    }

    if (ui.stage != PhotoStage.NONE) {
        PhotoStepsWindow(onBack = { if (ui.stage == PhotoStage.CROP) photos.retake() else photos.close() }) { insets ->
            val crop = ui.crop
            when {
                ui.stage == PhotoStage.CROP && crop != null -> PhotoCropScreen(
                    crop, useLabel = "Use photo", busyText = if (ui.uploading) "Saving…" else null, errorText = ui.error,
                    onRetake = photos::retake, onUse = photos::usePhoto, insets = insets,
                )
                ui.stage == PhotoStage.LOADING -> Column(Modifier.fillMaxSize()) {
                    PhotoStepBar("Cancel", backEnabled = true, title = "Photo", onBack = photos::close, topInset = insets.calculateTopPadding())
                    Row(Modifier.fillMaxWidth().weight(1f), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp))
                        Text("Loading photo…", style = MaterialTheme.typography.labelLarge, color = Color.White)
                    }
                }
                else -> PhotoCaptureSheet(
                    backLabel = "Cancel", onBack = photos::close, hasCamera = hasCamera, busyText = null, errorText = ui.error,
                    capturing = ui.capturing, onCaptureStart = photos::captureStarted,
                    onCapture = { bytes -> photos.use { decodeForCrop(bytes) } }, onCaptureFailed = photos::captureFailed,
                    front = ui.front, onFlip = photos::flip, onLibrary = pick, insets = insets,
                )
            }
        }
    }
}

/** A row of the photo sheet: an icon and the action. */
@Composable
private fun SheetOption(icon: ImageVector, text: String, tag: String, onClick: () -> Unit) {
    val c = LocalKioskColors.current
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).heightIn(min = 52.dp).padding(horizontal = 18.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = c.textDark, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(14.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = c.textDark)
    }
}

/** Choose photo: a framed picture. */
private val PictureIcon: ImageVector = lineIcon(
    "picture",
    listOf("M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M3 16l5-5 4 4 3-3 6 6"),
    fills = listOf("M15.5 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"),
)

/** The photo (white ring, soft shadow) with the amber camera badge at its lower right. */
@Composable
private fun PhotoWithBadge(
    personId: String, name: String, photoUrl: String?, photoVersion: String?, size: Dp,
    badgeEnabled: Boolean, onPhoto: () -> Unit,
) {
    val c = LocalKioskColors.current
    val badge = if (size > 100.dp) 34.dp else 28.dp
    Box {
        WorkerAvatar(
            personId, name, photoUrl, photoVersion, size,
            Modifier.shadow(10.dp, CircleShape).border(4.dp, Color.White, CircleShape),
        )
        Box(
            Modifier.align(Alignment.BottomEnd).size(badge).alpha(if (badgeEnabled) 1f else 0.45f)
                .border(3.dp, Color.White, CircleShape).clip(CircleShape).background(c.accent)
                .clickable(enabled = badgeEnabled, onClick = onPhoto)
                .semantics { contentDescription = "Change photo" }.testTag("worker-photo"),
            contentAlignment = Alignment.Center,
        ) {
            Icon(CameraIcon, contentDescription = null, tint = c.ink, modifier = Modifier.size(badge * 0.5f))
        }
    }
}

@Composable
private fun InfoCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    val c = LocalKioskColors.current
    Column(
        Modifier.fillMaxWidth().padding(top = 10.dp).clip(RoundedCornerShape(14.dp)).background(c.paper)
            .border(1.dp, c.paperLine, RoundedCornerShape(14.dp)).padding(bottom = 6.dp),
    ) {
        Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textMute, modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 4.dp))
        content()
    }
}

@Composable
private fun Field(label: String, value: String?, mono: Boolean = false) {
    val c = LocalKioskColors.current
    Column {
        Spacer(Modifier.fillMaxWidth().height(1.dp).background(c.paperLine))
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = c.textMute, modifier = Modifier.width(120.dp))
            Text(
                value?.takeIf { it.isNotBlank() } ?: "—", style = MaterialTheme.typography.bodyMedium, color = c.textDark,
                fontFamily = if (mono) FragmentMono else null, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ── Edit ──

/**
 * The Edit form (mockup "Editing"): first* and last*, preferred name, job title, phone, email,
 * company, trade, level and status, with a required note when Blacklist is chosen. Employee ID
 * and RFID stay read-only. The fields keep their own text (typing never waits on the view model's
 * flow) and hand every change to [RolodexViewModel.updateEdit].
 */
@Composable
private fun EditForm(ui: RolodexUi, detail: RolodexDetail, start: RolodexEdit, vm: RolodexViewModel, wide: Boolean) {
    val c = LocalKioskColors.current
    var form by remember(detail.person_id) { mutableStateOf(start) }
    var picker by remember { mutableStateOf<String?>(null) }
    val saving = ui.saving
    fun change(next: RolodexEdit) { form = next; vm.updateEdit(next) }
    val pair = Modifier.fillMaxWidth().padding(top = 8.dp)

    PageHeader("Edit worker", detail.display_name)
    Row(pair, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextBox("First name *", form.firstName, saving, "edit-first", Modifier.weight(1f), words = true) { change(form.copy(firstName = it)) }
        TextBox("Last name *", form.lastName, saving, "edit-last", Modifier.weight(1f), words = true) { change(form.copy(lastName = it)) }
    }
    TextBox("Preferred name", form.preferredName, saving, "edit-preferred", pair, words = true) { change(form.copy(preferredName = it)) }
    TextBox("Job title", form.jobTitle, saving, "edit-job", pair, words = true) { change(form.copy(jobTitle = it)) }
    if (wide) {
        Row(pair, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextBox("Phone", form.phone, saving, "edit-phone", Modifier.weight(1f), keyboard = KeyboardType.Phone) { change(form.copy(phone = it)) }
            TextBox("Email", form.email, saving, "edit-email", Modifier.weight(1f), keyboard = KeyboardType.Email) { change(form.copy(email = it)) }
        }
    } else {
        TextBox("Phone", form.phone, saving, "edit-phone", pair, keyboard = KeyboardType.Phone) { change(form.copy(phone = it)) }
        TextBox("Email", form.email, saving, "edit-email", pair, keyboard = KeyboardType.Email) { change(form.copy(email = it)) }
    }
    val companies = companyChoices(ui.options, detail)
    val levels = levelChoices(ui.options, detail)
    PickBox("Company", companies.firstOrNull { it.first == form.partnerId }?.second ?: "None", saving, "edit-company", pair) { picker = "company" }
    Row(pair, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextBox("Trade", form.trade, saving, "edit-trade", Modifier.weight(1f), words = true) { change(form.copy(trade = it)) }
        PickBox("Level", levels.firstOrNull { it.first == form.level }?.second ?: "None", saving, "edit-level", Modifier.weight(1f)) { picker = "level" }
    }

    Text("Status", style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 14.dp, bottom = 4.dp))
    Segmented(editStatuses(ui.options, detail), form.status, enabled = detail.can_change_status && !saving, modifier = Modifier.testTag("edit-status")) {
        change(form.copy(status = it))
    }
    if (!detail.can_change_status) {
        Text(statusBlockedText(detail.status_block_reason), style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
    }
    if (form.status == BLACKLIST_STATUS) {
        OutlinedTextField(
            form.statusNote, { change(form.copy(statusNote = it)) }, label = { Text("Blacklist note *") },
            placeholder = { Text("Why is this worker blocked?") }, enabled = !saving && detail.can_change_status, minLines = 2,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            modifier = pair.testTag("edit-status-note"),
        )
    }
    Text(
        "Employee ID ${detail.external_id?.takeIf { it.isNotBlank() } ?: "—"} · RFID ${if (detail.rfid_enrolled) "enrolled" else "not enrolled"}",
        style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 10.dp),
    )
    KioskToast(ui.error, error = true)
    Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
        MiniButton("Cancel", onClick = vm::cancelEdit, enabled = !saving, modifier = Modifier.testTag("edit-cancel"))
        SolidButton(if (saving) "Saving…" else "Save changes", onClick = vm::save, enabled = !saving, modifier = Modifier.testTag("edit-save"))
    }

    when (picker) {
        "company" -> PickerDialog("Company", companies, form.partnerId, onPick = { change(form.copy(partnerId = it)); picker = null }, onDismiss = { picker = null })
        "level" -> PickerDialog("Level", levels, form.level, onPick = { change(form.copy(level = it)); picker = null }, onDismiss = { picker = null })
    }
}

@Composable
internal fun TextBox(
    label: String, value: String, saving: Boolean, tag: String, modifier: Modifier,
    words: Boolean = false, keyboard: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value, onChange, label = { Text(label) }, singleLine = true, enabled = !saving,
        keyboardOptions = KeyboardOptions(
            capitalization = if (words) KeyboardCapitalization.Words else KeyboardCapitalization.None,
            autoCorrectEnabled = false, keyboardType = keyboard,
        ),
        modifier = modifier.testTag(tag),
    )
}

/**
 * A field-shaped button that opens a picker: an outlined box like the text fields, with a chevron.
 * [hint] shows [value] muted, as a prompt ("Choose a company") rather than a choice.
 */
@Composable
internal fun PickBox(label: String, value: String, saving: Boolean, tag: String, modifier: Modifier, hint: Boolean = false, onClick: () -> Unit) {
    val c = LocalKioskColors.current
    Box(modifier) {
        OutlinedTextField(
            value, {}, label = { Text(label) }, singleLine = true, readOnly = true, enabled = !saving,
            textStyle = if (hint) LocalTextStyle.current.copy(color = c.textMute) else LocalTextStyle.current,
            trailingIcon = { Icon(TcChevronIcon, contentDescription = null, tint = c.textMute, modifier = Modifier.size(18.dp)) },
            modifier = Modifier.fillMaxWidth(),
        )
        // Over the field: the whole box opens the picker (a read-only field would only take focus).
        Box(Modifier.matchParentSize().padding(top = 8.dp).clickable(enabled = !saving, onClick = onClick).testTag(tag))
    }
}

/** A list to pick one from (the app has no dropdowns): a search box above long lists. */
@Composable
internal fun PickerDialog(title: String, choices: List<Pair<String?, String>>, selected: String?, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    val c = LocalKioskColors.current
    var query by remember { mutableStateOf("") }
    val terms = queryTerms(query)
    val shown = if (terms.isEmpty()) choices else choices.filter { (_, name) -> matchesTerms(fold(name).split(' '), terms) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.fillMaxWidth().padding(16.dp).heightIn(max = 600.dp).background(c.paper, RoundedCornerShape(16.dp)).padding(16.dp),
        ) {
            Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textMute)
            if (choices.size > 8) {
                OutlinedTextField(
                    query, { query = it }, singleLine = true, placeholder = { Text("Search…") },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp).testTag("picker-search"),
                )
            }
            LazyColumn(Modifier.weight(1f, fill = false).padding(top = 8.dp)) {
                items(shown, key = { it.first ?: "\u0000none" }) { (id, name) ->
                    val on = id == selected
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (on) c.accent.copy(alpha = 0.14f) else c.paper)
                            .clickable { onPick(id) }.heightIn(min = 48.dp).padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(name, style = MaterialTheme.typography.bodyLarge, color = c.textDark, fontWeight = if (on) FontWeight.SemiBold else null, modifier = Modifier.weight(1f))
                        if (on) Text("✓", color = c.accent, fontSize = 18.sp)
                    }
                }
            }
            MiniButton("Cancel", onClick = onDismiss, modifier = Modifier.align(Alignment.End).padding(top = 8.dp))
        }
    }
}
