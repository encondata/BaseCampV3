import CoreData
import Foundation
import os
import SwiftData

/// What a store file that would not open turned out to be.
enum StoreHealth: Equatable, Sendable {
    /// No store file: the failure was the environment's (a full disk, say).
    case missing
    /// SQLite says it is not a database, or it is malformed.
    case corrupt
    /// Readable, and V1 or V2: the environment failed (disk full, I/O), not the file.
    case known
    /// Readable, but neither V1 nor V2 (a newer build wrote it).
    case unknownVersion
    /// Its metadata would not read for another reason.
    case unreadable
}

/// The store the app runs on this launch.
struct OpenedStore {
    let container: ModelContainer
    /// In memory because the on-disk store could not be used this launch:
    /// nothing written survives a relaunch.
    let isTemporary: Bool
    /// The folder a corrupt store was moved into, when one was.
    let movedAsideTo: URL?
    /// Outbox rows copied from the moved-aside store into the fresh one.
    let salvagedScans: Int
}

/// Opens the on-disk store and decides what to do when it will not open. A
/// store file is never deleted. Only a corrupt one is moved aside (its queued
/// scans are copied into the fresh store); any other failure leaves the file
/// alone and runs in memory for this launch, so the next launch can try again.
enum KioskStoreOpener {
    private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ServerSherpa Kiosk", category: "store")

    static func open(directory: URL, now: Date, protectedDataAvailable: () -> Bool,
                     open: (URL) throws -> ModelContainer = KioskSchema.container(url:),
                     classify: (URL) -> StoreHealth = classify(storeAt:),
                     inMemory: () -> ModelContainer) -> OpenedStore {
        let url = directory.appending(path: KioskSchema.storeFileName)
        func temporary(_ why: String) -> OpenedStore {
            log.error("The kiosk runs on an in-memory store this launch: \(why, privacy: .public)")
            return OpenedStore(container: inMemory(), isTemporary: true, movedAsideTo: nil, salvagedScans: 0)
        }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            return OpenedStore(container: try open(url), isTemporary: false, movedAsideTo: nil, salvagedScans: 0)
        } catch {
            log.error("The kiosk store would not open: \(String(describing: error), privacy: .public)")
        }
        guard protectedDataAvailable() else { return temporary("protected data is unavailable (the device is locked)") }
        let health = classify(url)
        guard health == .corrupt else { return temporary("the store is \(health), so it is left in place") }
        guard let folder = moveAside(directory: directory, now: now) else { return temporary("the corrupt store could not be moved aside") }
        log.error("The corrupt kiosk store was moved aside to \(folder.lastPathComponent, privacy: .public)")
        let fresh: ModelContainer
        do { fresh = try open(url) } catch {
            log.error("A fresh kiosk store would not open: \(String(describing: error), privacy: .public)")
            return OpenedStore(container: inMemory(), isTemporary: true, movedAsideTo: folder, salvagedScans: 0)
        }
        let salvaged = salvageOutbox(from: folder.appending(path: KioskSchema.storeFileName), into: fresh)
        log.notice("Salvaged \(salvaged, privacy: .public) queued scan(s) from the moved-aside store")
        return OpenedStore(container: fresh, isTemporary: false, movedAsideTo: folder, salvagedScans: salvaged)
    }

    /// Reads the store's metadata with Core Data, without opening it.
    static func classify(storeAt url: URL) -> StoreHealth {
        guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else { return .missing }
        let metadata: [String: Any]
        do {
            metadata = try NSPersistentStoreCoordinator.metadataForPersistentStore(type: .sqlite, at: url)
        } catch {
            return isCorruption(error) ? .corrupt : .unreadable
        }
        for models in [KioskSchemaV2.models, KioskSchemaV1.models] {
            if let model = frozenModel(models), model.isConfiguration(withName: nil, compatibleWithStoreMetadata: metadata) {
                return .known
            }
        }
        return .unknownVersion
    }

    /// SQLITE_CORRUPT (11), SQLITE_NOTADB (26), or Core Data's corrupt-file error.
    private static func isCorruption(_ error: Error) -> Bool {
        let ns = error as NSError
        if let code = ns.userInfo[NSSQLiteErrorDomain] as? Int, code == 11 || code == 26 { return true }
        if ns.domain == NSSQLiteErrorDomain, ns.code == 11 || ns.code == 26 { return true }
        return ns.domain == NSCocoaErrorDomain && ns.code == NSFileReadCorruptFileError
    }

    /// Moves the store and its `-wal`/`-shm` together into a new
    /// `serversherpa-kiosk.store.failed-<yyyyMMdd-HHmmss>/` folder, keeping
    /// their names (so SQLite still pairs them). On a partial failure the moved
    /// files go back where they were; nil means nothing stayed moved.
    static func moveAside(directory: URL, now: Date) -> URL? {
        let fm = FileManager.default
        let base = KioskSchema.failedStoreName(at: now)
        var folder = directory.appending(path: base)
        var n = 2
        while fm.fileExists(atPath: folder.path(percentEncoded: false)) {
            folder = directory.appending(path: "\(base)-\(n)")
            n += 1
        }
        do { try fm.createDirectory(at: folder, withIntermediateDirectories: false) } catch {
            log.error("The failed-store folder could not be created: \(String(describing: error), privacy: .public)")
            return nil
        }
        var moved: [(from: URL, to: URL)] = []
        for suffix in ["", "-wal", "-shm"] {
            let from = directory.appending(path: KioskSchema.storeFileName + suffix)
            guard fm.fileExists(atPath: from.path(percentEncoded: false)) else { continue }
            let to = folder.appending(path: KioskSchema.storeFileName + suffix)
            do {
                try fm.moveItem(at: from, to: to)
                moved.append((from, to))
            } catch {
                log.error("Moving \(from.lastPathComponent, privacy: .public) aside failed: \(String(describing: error), privacy: .public)")
                for pair in moved.reversed() {
                    do { try fm.moveItem(at: pair.to, to: pair.from) } catch {
                        log.fault("Rollback of \(pair.to.lastPathComponent, privacy: .public) failed: \(String(describing: error), privacy: .public)")
                    }
                }
                // Only an empty folder this call created is removed.
                if (try? fm.contentsOfDirectory(atPath: folder.path(percentEncoded: false)))?.isEmpty == true {
                    try? fm.removeItem(at: folder)
                }
                return nil
            }
        }
        return folder
    }

    /// Copies the outbox rows of the store at `url` (opened read-only through
    /// Core Data, as V2 then V1) into `container`. Returns how many were copied.
    static func salvageOutbox(from url: URL, into container: ModelContainer) -> Int {
        for models in [KioskSchemaV2.models, KioskSchemaV1.models] {
            guard let model = frozenModel(models) else { continue }
            let coordinator = NSPersistentStoreCoordinator(managedObjectModel: model)
            do {
                _ = try coordinator.addPersistentStore(type: .sqlite, at: url, options: [
                    NSReadOnlyPersistentStoreOption: true, NSPersistentHistoryTrackingKey: true,
                ])
            } catch { continue }
            defer { for store in coordinator.persistentStores { try? coordinator.remove(store) } }
            let context = NSManagedObjectContext(.privateQueue)
            context.persistentStoreCoordinator = coordinator
            do {
                let rows = try context.performAndWait {
                    try context.fetch(NSFetchRequest<NSManagedObject>(entityName: "OutboxRecord")).compactMap(outboxRow)
                }
                let target = ModelContext(container)
                for row in rows { target.insert(OutboxRecord(row)) }
                try target.save()
                return rows.count
            } catch {
                log.error("The outbox could not be salvaged: \(String(describing: error), privacy: .public)")
                return 0
            }
        }
        log.error("The moved-aside store could not be read for its outbox")
        return 0
    }

    private static func outboxRow(_ object: NSManagedObject) -> OutboxRow? {
        func string(_ key: String) -> String? { object.value(forKey: key) as? String }
        func number(_ key: String) -> NSNumber? { object.value(forKey: key) as? NSNumber }
        guard let id = string("clientScanId") else { return nil }
        return OutboxRow(clientScanId: id, seq: number("seq")?.int64Value ?? 0, scannedValue: string("scannedValue") ?? "",
                         scanType: string("scanType") ?? "", scannedAt: string("scannedAt") ?? "",
                         asset: string("asset").flatMap { decodeJson(OutboxAsset.self, $0) }, matched: number("matched")?.boolValue ?? false,
                         status: string("status").flatMap(OutboxStatus.init(rawValue:)) ?? .queued, attempts: number("attempts")?.intValue ?? 0,
                         nextAttemptAt: number("nextAttemptAt")?.int64Value, lastError: string("lastError"), siteId: string("siteId") ?? "",
                         initiativeId: string("initiativeId") ?? "", scanStatus: string("scanStatus") ?? "")
    }

    /// The Core Data model SwiftData builds for `models`, frozen (attached to a
    /// coordinator) so its version hashes are stable.
    static func frozenModel(_ models: [any PersistentModel.Type]) -> NSManagedObjectModel? {
        guard let model = NSManagedObjectModel.makeManagedObjectModel(for: models) else { return nil }
        _ = NSPersistentStoreCoordinator(managedObjectModel: model)
        return model
    }
}
