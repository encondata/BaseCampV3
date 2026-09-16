package com.serversherpa.kiosk.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

const val MOVE_META_KEY = "sync"

@Database(
    entities = [AssetEntity::class, PersonEntity::class, ContainerEntity::class, TruckEntity::class, MetaEntity::class, OutboxEntity::class],
    version = 1, exportSchema = false,
)
abstract class KioskDatabase : RoomDatabase() {
    abstract fun assets(): AssetDao
    abstract fun people(): PersonDao
    abstract fun containers(): ContainerDao
    abstract fun trucks(): TruckDao
    abstract fun meta(): MetaDao
    abstract fun outbox(): OutboxDao

    companion object {
        fun build(context: Context): KioskDatabase =
            Room.databaseBuilder(context.applicationContext, KioskDatabase::class.java, "serversherpa-kiosk").build()

        fun inMemory(context: Context): KioskDatabase =
            Room.inMemoryDatabaseBuilder(context.applicationContext, KioskDatabase::class.java).allowMainThreadQueries().build()
    }
}
