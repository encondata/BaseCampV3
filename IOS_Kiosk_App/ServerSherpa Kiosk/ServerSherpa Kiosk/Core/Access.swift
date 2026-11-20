import Foundation

/// portal/src/lib/access.ts: rank 60 and up is admin client-side.
let ADMIN_RANK = 60
/// Developer, founder and super admin: rank 80 and up (a Custom URL on a registered kiosk).
let SUPER_ADMIN_RANK = 80

func computeCan(_ perms: [String: [String: Bool]]?, _ resource: String, _ action: String) -> Bool {
    perms?[resource]?[action] == true
}
