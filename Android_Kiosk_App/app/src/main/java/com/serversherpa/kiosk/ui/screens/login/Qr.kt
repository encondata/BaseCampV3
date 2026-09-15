package com.serversherpa.kiosk.ui.screens.login

import android.graphics.Bitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

fun formatCode(code: String): String = if (code.length > 4) "${code.take(4)}-${code.drop(4)}" else code

fun portalHost(url: String): String = try { java.net.URI(url).host ?: url } catch (e: Exception) { url }

/** A QR of `text`, dark on light, `sizePx` square. */
fun qrBitmap(text: String, sizePx: Int, dark: Int = 0xFF1B2129.toInt(), light: Int = 0xFFFBFCFD.toInt()): Bitmap {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, sizePx, sizePx, mapOf(EncodeHintType.MARGIN to 1, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M))
    val pixels = IntArray(sizePx * sizePx)
    for (y in 0 until sizePx) for (x in 0 until sizePx) pixels[y * sizePx + x] = if (matrix[x, y]) dark else light
    val bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
    bmp.setPixels(pixels, 0, sizePx, 0, 0, sizePx, sizePx)
    return bmp
}
