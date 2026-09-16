package com.serversherpa.kiosk.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.serversherpa.kiosk.R

// FontVariation on a resource Font is still @ExperimentalTextApi in this Compose version.
@OptIn(ExperimentalTextApi::class)
private fun geologica(weight: FontWeight) = Font(
    R.font.geologica, weight = weight,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
)

/** `--font-display`: Geologica (variable), the weights the portal loads. */
val Geologica = FontFamily(
    geologica(FontWeight.Light), geologica(FontWeight.Normal), geologica(FontWeight.Medium),
    geologica(FontWeight.SemiBold), geologica(FontWeight.ExtraBold),
)

/** `--font-mono`: Fragment Mono. */
val FragmentMono = FontFamily(
    Font(R.font.fragment_mono, weight = FontWeight.Normal),
    Font(R.font.fragment_mono_italic, weight = FontWeight.Normal, style = FontStyle.Italic),
)

val KioskTypography = Typography(
    displaySmall = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.SemiBold, fontSize = 28.sp),
    headlineSmall = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.SemiBold, fontSize = 22.sp),
    titleLarge = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
    titleMedium = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    bodyLarge = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.Normal, fontSize = 16.sp),
    bodyMedium = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.Normal, fontSize = 14.sp),
    bodySmall = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.Normal, fontSize = 12.sp),
    labelLarge = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelMedium = TextStyle(fontFamily = FragmentMono, fontSize = 12.sp, letterSpacing = 0.5.sp),
    labelSmall = TextStyle(fontFamily = FragmentMono, fontSize = 11.sp, letterSpacing = 1.sp),
)
