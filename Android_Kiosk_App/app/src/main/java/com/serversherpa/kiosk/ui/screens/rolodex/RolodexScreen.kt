package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** From this page width up, the list and the worker page sit side by side (spec §3.10). */
private val SPLIT_MIN_WIDTH = 600.dp

/** The list pane's width in the split view. */
private val LIST_PANE_WIDTH = 360.dp

/** The Rolodex route: admins only (AdminGate), inside the kiosk shell without its page scroll. */
@Composable
fun RolodexScreen(@Suppress("UNUSED_PARAMETER") nav: NavHostController) {
    val container = LocalAppContainer.current
    val vm = kioskViewModel { RolodexViewModel(container.api, container.db) }
    // Task 7 hooks: the New worker flow (onNewWorker) and the photo sheet (onChangePhoto).
    // Until they are wired, "+ New" and the camera badge show disabled.
    RolodexContent(vm, onNewWorker = null, onChangePhoto = null)
}

/**
 * The list and the selected worker's page: side by side from [SPLIT_MIN_WIDTH] (list
 * [LIST_PANE_WIDTH]), otherwise one at a time with the page full screen. Ruling P3: Android has
 * no top-bar back, so the phone's page has its own "‹ Rolodex", and system Back closes the page
 * (or cancels an open Edit form first).
 */
@Composable
internal fun RolodexContent(vm: RolodexViewModel, onNewWorker: (() -> Unit)?, onChangePhoto: ((personId: String) -> Unit)?) {
    val c = LocalKioskColors.current
    val ui by vm.state.collectAsStateWithLifecycle()
    // Here, not in the list: the phone's list leaves the screen while a page is open, and the
    // search text and scroll position must be as they were when it comes back.
    var query by remember { mutableStateOf(ui.query) }
    val listState = rememberLazyListState()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= SPLIT_MIN_WIDTH
        BackHandler(enabled = ui.editing != null && !ui.saving) { vm.cancelEdit() }
        BackHandler(enabled = !wide && ui.selectedId != null && ui.editing == null) { vm.select(null) }
        val photo = onChangePhoto?.let { open -> ui.selectedId?.let { id -> { open(id) } } }
        val list = @Composable { modifier: Modifier ->
            RolodexList(
                ui, query, onQuery = { query = it; vm.setQuery(it) }, onFilter = vm::setFilter, onSelect = vm::select,
                onRefresh = vm::refresh, onNew = onNewWorker, listState = listState, modifier = modifier,
            )
        }
        when {
            wide -> Row(Modifier.fillMaxSize()) {
                list(Modifier.width(LIST_PANE_WIDTH).fillMaxHeight())
                Spacer(Modifier.width(16.dp))
                if (ui.selectedId == null) {
                    Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.Center) {
                        Text("Choose a worker to see their page.", style = MaterialTheme.typography.bodyLarge, color = c.textMute)
                    }
                } else {
                    WorkerPage(ui, vm, wide = true, onBack = null, onPhoto = photo, modifier = Modifier.weight(1f).fillMaxHeight())
                }
            }
            ui.selectedId == null -> list(Modifier.fillMaxSize())
            else -> WorkerPage(ui, vm, wide = false, onBack = { vm.select(null) }, onPhoto = photo, modifier = Modifier.fillMaxSize().padding(bottom = 4.dp))
        }
    }
}
