package com.serversherpa.kiosk.input.camera

import android.content.Context
import android.content.pm.PackageManager
import com.google.mlkit.vision.barcode.common.Barcode

fun hasCamera(context: Context): Boolean = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

fun formatName(format: Int): String? = when (format) {
    Barcode.FORMAT_QR_CODE -> "QR_CODE"; Barcode.FORMAT_CODE_128 -> "CODE128"; Barcode.FORMAT_CODE_39 -> "CODE39"
    Barcode.FORMAT_CODE_93 -> "CODE93"; Barcode.FORMAT_EAN_13 -> "EAN13"; Barcode.FORMAT_EAN_8 -> "EAN8"
    Barcode.FORMAT_UPC_A -> "UPCA"; Barcode.FORMAT_UPC_E -> "UPCE"; Barcode.FORMAT_DATA_MATRIX -> "DATAMATRIX"
    Barcode.FORMAT_PDF417 -> "PDF417"; Barcode.FORMAT_AZTEC -> "AZTEC"; Barcode.FORMAT_ITF -> "ITF"; Barcode.FORMAT_CODABAR -> "CODABAR"
    else -> null
}
