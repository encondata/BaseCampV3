//
//  Item.swift
//  ServerSherpa Kiosk
//
//  Created by James Henderson on 9/15/26.
//

import Foundation
import SwiftData

@Model
final class Item {
    var timestamp: Date
    
    init(timestamp: Date) {
        self.timestamp = timestamp
    }
}
