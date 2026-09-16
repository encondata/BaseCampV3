package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.delay

/**
 * The always-focused box: a barcode scanner is a keyboard, so whatever
 * it types lands here and its Enter submits. `keepFocus` reclaims focus
 * when it drifts (a tap on empty space, the app coming back).
 */
@Composable
fun ScanInput(
    value: String,
    onValueChange: (String) -> Unit,
    onSubmit: (String) -> Unit,
    placeholder: String,
    enabled: Boolean = true,
    keepFocus: Boolean = true,
    modifier: Modifier = Modifier,
    /** Sits inside the box on the right — the camera lives here rather than in a
     *  button below, so the scan line is one thing and not two. */
    trailingIcon: @Composable (() -> Unit)? = null,
) {
    val requester = remember { FocusRequester() }
    LaunchedEffect(enabled, keepFocus) { if (enabled && keepFocus) { delay(50); runCatching { requester.requestFocus() } } }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = true,
        placeholder = { Text(placeholder) },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onDone = { val v = value.trim(); if (v.isNotEmpty()) onSubmit(v) }),
        trailingIcon = trailingIcon,
        modifier = modifier.fillMaxWidth().testTag("scan-input").focusRequester(requester)
            .onFocusChanged { if (!it.isFocused && enabled && keepFocus) runCatching { requester.requestFocus() } },
    )
}

/** The camera affordance for a scan box: tap the lens, the full-screen scanner opens. */
@Composable
fun CameraFieldButton(enabled: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled) {
        Icon(CameraIcon, contentDescription = "Scan with the camera", tint = LocalKioskColors.current.accent)
    }
}
