package com.serversherpa.kiosk

import java.nio.file.FileSystems
import java.util.concurrent.TimeUnit
import org.junit.rules.TestRule
import org.junit.runner.Description
import org.junit.runners.model.Statement
import org.robolectric.annotation.GraphicsMode

/**
 * Before a native-graphics test, waits out another Robolectric sandbox that is
 * still unpacking the native runtime's fonts (about 160 MB).
 *
 * Robolectric 4.14 holds the fonts jar open as a zip file system while it
 * copies them. A sandbox that starts loading meanwhile fails with
 * FileSystemAlreadyExistsException. The legacy-graphics tests start that copy
 * on a background thread (Room's first query), so a native-graphics test right
 * after them would collide with it. The file system is open exactly while a
 * copy is in progress.
 *
 * Use it outside the compose rule, so it runs before the test's activity
 * starts: `RuleChain.outerRule(NativeFontsSettled()).around(compose)`. It only
 * acts on tests annotated `@GraphicsMode(NATIVE)`, on the method or on the class.
 */
class NativeFontsSettled : TestRule {
    override fun apply(base: Statement, description: Description): Statement = object : Statement() {
        override fun evaluate() {
            val mode = description.getAnnotation(GraphicsMode::class.java) ?: description.testClass?.getAnnotation(GraphicsMode::class.java)
            if (mode?.value == GraphicsMode.Mode.NATIVE) awaitFontsCopied()
            base.evaluate()
        }
    }

    private fun awaitFontsCopied() {
        val fonts = javaClass.classLoader?.getResource("fonts/")?.toURI()?.takeIf { it.scheme == "jar" } ?: return
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
        while (runCatching { FileSystems.getFileSystem(fonts) }.isSuccess && System.nanoTime() < deadline) Thread.sleep(20)
    }
}
