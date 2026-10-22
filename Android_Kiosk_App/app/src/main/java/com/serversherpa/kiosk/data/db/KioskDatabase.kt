package com.serversherpa.kiosk.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

const val MOVE_META_KEY = "sync"
/** The move's `label_context` object from /kiosk/sync/assets, raw JSON text (`null` when absent). */
const val LABEL_CONTEXT_META_KEY = "label_context"

/** Version 2: assets keep their raw payload; label templates, fonts and generated labels. */
val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `assets` ADD COLUMN `payload_json` TEXT NOT NULL DEFAULT '{}'")
        db.execSQL("CREATE TABLE IF NOT EXISTS `label_templates` (`id` TEXT NOT NULL, `json` TEXT NOT NULL, PRIMARY KEY(`id`))")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `label_fonts` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `size` INTEGER NOT NULL, " +
                "`resident` INTEGER NOT NULL, `file_name` TEXT, PRIMARY KEY(`id`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `generated_labels` (`asset_id` TEXT NOT NULL, `zpl` TEXT, `outcome` TEXT NOT NULL, " +
                "`fingerprint` TEXT NOT NULL, `template_id` TEXT, PRIMARY KEY(`asset_id`))",
        )
    }
}

/** Version 3: people keep their badge UUID, job title and Employee ID (the Time Clock's badge
 *  door and confirm card). Nullable: an upgraded roster fills them on its next sync. */
val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `people` ADD COLUMN `badge_uid` TEXT")
        db.execSQL("ALTER TABLE `people` ADD COLUMN `job_title` TEXT")
        db.execSQL("ALTER TABLE `people` ADD COLUMN `external_id` TEXT")
    }
}

@Database(
    entities = [
        AssetEntity::class, PersonEntity::class, ContainerEntity::class, TruckEntity::class, MetaEntity::class, OutboxEntity::class,
        LabelTemplateEntity::class, LabelFontEntity::class, GeneratedLabelEntity::class,
    ],
    version = 3, exportSchema = true,
)
abstract class KioskDatabase : RoomDatabase() {
    abstract fun assets(): AssetDao
    abstract fun people(): PersonDao
    abstract fun containers(): ContainerDao
    abstract fun trucks(): TruckDao
    abstract fun meta(): MetaDao
    abstract fun outbox(): OutboxDao
    abstract fun labelTemplates(): LabelTemplateDao
    abstract fun labelFonts(): LabelFontDao
    abstract fun generatedLabels(): GeneratedLabelDao

    companion object {
        const val NAME = "serversherpa-kiosk"

        /** Every migration, oldest first. A schema change adds one here and exports its schema. */
        val MIGRATIONS = arrayOf(MIGRATION_1_2, MIGRATION_2_3)

        fun build(context: Context): KioskDatabase =
            Room.databaseBuilder(context.applicationContext, KioskDatabase::class.java, NAME).addMigrations(*MIGRATIONS).build()

        fun inMemory(context: Context): KioskDatabase =
            Room.inMemoryDatabaseBuilder(context.applicationContext, KioskDatabase::class.java).allowMainThreadQueries().build()
    }
}
