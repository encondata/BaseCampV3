package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.serversherpa.kiosk.ui.components.lineIcon
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.Geologica

/**
 * The sign-in screen's own palette: portal/src/styles/login-light.css re-declares
 * its colors locally (`--lx-*`) instead of using the app's tokens, and so does this
 * screen. Nothing outside the login package reads these.
 */
internal object LoginPalette {
    val Ink = Color(0xFF0F172A)
    val Orange = Color(0xFFFF6A00)
    val Canvas = Color(0xFFFFF9F2)
    val Slate = Color(0xFF64748B)
    val Line = Color(0xFFCBD5E1)
    val Field = Color(0xFFF8FAFC)
    val Ok = Color(0xFF22C55E)

    // Small details the web sheet spells out inline rather than as tokens.
    val Placeholder = Color(0xFF94A3B8)   // .control input::placeholder
    val Invalid = Color(0xFFE5484D)       // input.invalid border (auth-theme.css)
    val ErrorText = Color(0xFFC93A3F)     // .error-msg
    val InkHover = Color(0xFF1E293B)      // .btn:hover, kept as the pressed shade
}

// Path data copied from portal/src/components/login/loginIcons.tsx.
internal val EyeIcon: ImageVector = lineIcon(
    "eye",
    listOf("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z", "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"),
)
internal val EyeOffIcon: ImageVector = lineIcon(
    "eye-off",
    listOf(
        "M3 3l18 18",
        "M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5",
        "M9.9 9.9a3 3 0 0 0 4.2 4.2",
    ),
)
internal val ArrowIcon: ImageVector = lineIcon("arrow", listOf("M5 12h14M13 6l6 6-6 6"))
internal val RouteLinkIcon: ImageVector = lineIcon(
    "route-link",
    listOf("M20.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z", "M10.5 17a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z", "m9.5 14.5 5-5"),
)
internal val LockIcon: ImageVector = lineIcon(
    "lock",
    listOf("M7 11V8a5 5 0 0 1 10 0v3", "M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"),
)
// A QR code: three finder squares and a scatter of modules, drawn as outlines like the other login glyphs.
internal val QrCodeIcon: ImageVector = lineIcon(
    "qr-code",
    listOf(
        "M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z",
        "M14 14h2v2h-2z", "M18 14h2", "M14 18h2", "M18 18h2v2h-2z",
    ),
)
// The kiosk web's pane-gear glyph (kiosk/src/pages/Login.tsx).
internal val GearIcon: ImageVector = lineIcon(
    "gear",
    listOf(
        "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
        "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
    ),
)

private val FieldShape = RoundedCornerShape(8.dp)
private val ButtonShape = RoundedCornerShape(8.dp)

/** `.field label`: upper-case, letterspaced mono, slate, sitting above the field. */
@Composable
internal fun LoginFieldLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(), fontFamily = FragmentMono, fontSize = 12.sp, letterSpacing = 3.6.sp, color = LoginPalette.Slate,
        modifier = modifier.padding(bottom = 8.dp),
    )
}

/** A label above a light, rounded, thinly bordered field. [trailing] sits inside the field on the right. */
@Composable
internal fun LoginField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    tag: String,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    invalid: Boolean = false,
    masked: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
) {
    Column(modifier.fillMaxWidth()) {
        LoginFieldLabel(label)
        OutlinedTextField(
            value = value, onValueChange = onValueChange, isError = invalid, singleLine = true,
            shape = FieldShape,
            textStyle = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.Normal, fontSize = 16.sp, color = LoginPalette.Ink),
            placeholder = placeholder?.let { { Text(it, color = LoginPalette.Placeholder, fontFamily = Geologica) } },
            visualTransformation = if (masked) PasswordVisualTransformation() else VisualTransformation.None,
            trailingIcon = trailing,
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = LoginPalette.Field, unfocusedContainerColor = LoginPalette.Field,
                errorContainerColor = LoginPalette.Field, disabledContainerColor = LoginPalette.Field,
                focusedBorderColor = LoginPalette.Orange, unfocusedBorderColor = LoginPalette.Line,
                errorBorderColor = LoginPalette.Invalid,
                focusedTextColor = LoginPalette.Ink, unfocusedTextColor = LoginPalette.Ink, errorTextColor = LoginPalette.Ink,
                cursorColor = LoginPalette.Orange, errorCursorColor = LoginPalette.Invalid,
            ),
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag(tag).semantics { contentDescription = label },
        )
    }
}

/** The eye inside the password field: 48 dp target, orange while the password is showing. */
@Composable
internal fun PasswordEye(showing: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(48.dp).testTag("login-eye")) {
        Icon(
            if (showing) EyeOffIcon else EyeIcon,
            contentDescription = if (showing) "Hide password" else "Show password",
            tint = if (showing) LoginPalette.Orange else LoginPalette.Slate,
            modifier = Modifier.size(22.dp),
        )
    }
}

/** The QR button inside the Move password field: 48 dp target, opens the camera to read the move's QR code. */
@Composable
internal fun MoveScanButton(enabled: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(48.dp).testTag("login-move-scan")) {
        Icon(QrCodeIcon, contentDescription = "Scan the move password's QR code", tint = if (enabled) LoginPalette.Orange else LoginPalette.Slate)
    }
}

/** The one primary action: full width, ink, rounded, with the orange trailing arrow (a spinner while [loading]). */
@Composable
internal fun LoginPrimaryButton(
    text: String, onClick: () -> Unit, modifier: Modifier = Modifier, loading: Boolean = false, enabled: Boolean = true, arrow: Boolean = true,
) {
    Button(
        onClick = onClick, enabled = enabled, shape = ButtonShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = LoginPalette.Ink, contentColor = Color.White,
            // Only "Signing in…" disables it, and the web keeps the ink button while it spins.
            disabledContainerColor = LoginPalette.Ink, disabledContentColor = Color.White,
        ),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 14.dp),
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp),
    ) {
        Text(text, fontFamily = Geologica, fontWeight = FontWeight.Medium, fontSize = 17.sp)
        if (loading) {
            Spacer(Modifier.width(10.dp))
            CircularProgressIndicator(Modifier.size(18.dp), color = LoginPalette.Orange, trackColor = Color.White.copy(alpha = .25f), strokeWidth = 2.dp)
        } else if (arrow) {
            Spacer(Modifier.width(10.dp))
            Icon(ArrowIcon, contentDescription = null, tint = LoginPalette.Orange, modifier = Modifier.size(22.dp))
        }
    }
}

/** `.btn-sso`, the mockup's outlined secondary button, here carrying a kiosk route. */
@Composable
internal fun LoginSecondaryButton(text: String, icon: ImageVector, onClick: () -> Unit, modifier: Modifier = Modifier) {
    OutlinedButton(
        onClick = onClick, shape = ButtonShape,
        border = BorderStroke(1.dp, LoginPalette.Line),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = Color.White.copy(alpha = .85f), contentColor = LoginPalette.Ink),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
    ) {
        Icon(icon, contentDescription = null, tint = LoginPalette.Orange, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(10.dp))
        Text(text, fontFamily = Geologica, fontWeight = FontWeight.Normal, fontSize = 16.sp)
    }
}

/** `.link`: ink text with an underline, at least 48 dp tall. */
@Composable
internal fun LoginLink(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    // No side padding: TextButton's default 12 dp pushed these links in from
    // the margin every field and button shares. The 48 dp height stays.
    TextButton(onClick = onClick, modifier = modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 0.dp)) {
        Text(text, color = LoginPalette.Ink, fontFamily = Geologica, fontSize = 14.sp, textDecoration = TextDecoration.Underline)
    }
}

/** `.divider`: a hairline, OR in letterspaced mono, a hairline. */
@Composable
internal fun LoginOrDivider(modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(vertical = 22.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        HorizontalDivider(Modifier.weight(1f), color = LoginPalette.Line)
        Text("OR", fontFamily = FragmentMono, fontSize = 12.sp, letterSpacing = 3.6.sp, color = LoginPalette.Slate)
        HorizontalDivider(Modifier.weight(1f), color = LoginPalette.Line)
    }
}

/** A banner or a note above the form. Errors read red, everything else neutral. */
@Composable
internal fun LoginNotice(text: String?, error: Boolean = false, modifier: Modifier = Modifier) {
    if (text == null) return
    val tint = if (error) LoginPalette.Invalid else LoginPalette.Ok
    Text(
        text, fontFamily = Geologica, fontSize = 14.sp, color = if (error) LoginPalette.ErrorText else LoginPalette.Ink,
        modifier = modifier.fillMaxWidth().padding(vertical = 6.dp)
            .background(tint.copy(alpha = .12f), RoundedCornerShape(8.dp))
            .padding(12.dp),
    )
}
