package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.core.settings.Hsl
import com.serversherpa.kiosk.core.settings.hslCss
import com.serversherpa.kiosk.core.settings.hslToArgb

/** One color: swatch, three channel sliders, the hsl() readout, Preview flash. */
@Composable
fun HslPicker(name: String, value: Hsl, onChange: (Hsl) -> Unit, onPreview: () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            androidx.compose.foundation.layout.Box(Modifier.size(40.dp).background(Color(hslToArgb(value)), RoundedCornerShape(8.dp)))
            Text(hslCss(value), style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 12.dp))
        }
        Channel("Hue", value.h, 360f) { onChange(value.copy(h = it)) }
        Channel("Saturation", value.s, 100f) { onChange(value.copy(s = it)) }
        Channel("Lightness", value.l, 100f) { onChange(value.copy(l = it)) }
        MiniButton("Preview flash", onClick = onPreview)
    }
}

@Composable
private fun Channel(label: String, v: Double, max: Float, onChange: (Double) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(84.dp))
        Slider(value = v.toFloat(), onValueChange = { onChange(Math.round(it).toDouble()) }, valueRange = 0f..max, modifier = Modifier.weight(1f))
        Text("${Math.round(v)}", style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(40.dp))
    }
}
