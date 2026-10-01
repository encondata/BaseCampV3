package com.serversherpa.kiosk.input.camera

import androidx.annotation.OptIn
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage

/** Runs ML Kit on each frame; `onValue(value, symbology)` per decoded barcode. [formats] (ML Kit
 *  `Barcode.FORMAT_*`) limits what is decoded; empty means every format. */
class BarcodeAnalyzer(private val onValue: (String, String?) -> Unit, formats: IntArray = intArrayOf()) : ImageAnalysis.Analyzer {
    private val scanner = if (formats.isEmpty()) BarcodeScanning.getClient()
        else BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(formats.first(), *formats.drop(1).toIntArray()).build())

    @OptIn(ExperimentalGetImage::class)
    override fun analyze(image: ImageProxy) {
        val media = image.image
        if (media == null) { image.close(); return }
        val input = InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees)
        scanner.process(input)
            .addOnSuccessListener { codes ->
                for (code in codes) code.rawValue?.let { onValue(it, formatName(code.format)) }
            }
            .addOnCompleteListener { image.close() }
    }

    fun close() = scanner.close()
}
