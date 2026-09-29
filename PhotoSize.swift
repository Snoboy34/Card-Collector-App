import Foundation
import CoreMedia

/// Still size picked from the device's `supportedMaxPhotoDimensions`.
/// 12 MP is the default: the largest offered size at or under 12.2 MP
/// (4032×3024 is 12,192,768 px). Max is the largest offered size.
/// The grade engine decodes at most 2400 px on the long side, so Max does not
/// add measurement detail and can blow the server's 10 MB upload limit.
enum PhotoSizeSetting: String, CaseIterable, Identifiable {
    case twelveMP = "12mp"
    case max = "max"

    static let defaultsKey = "judgePhotoSize"
    static let twelveMegapixelCap = 12_200_000

    var id: String { rawValue }

    var label: String {
        switch self {
        case .twelveMP: return "12 MP"
        case .max: return "Max"
        }
    }

    static func resolved(_ raw: String?) -> PhotoSizeSetting {
        guard let raw, let setting = PhotoSizeSetting(rawValue: raw) else { return .twelveMP }
        return setting
    }

    static func current() -> PhotoSizeSetting {
        resolved(UserDefaults.standard.string(forKey: defaultsKey))
    }

    /// A member of `supported`, or nil when the device listed nothing usable.
    static func choose(_ setting: PhotoSizeSetting, supported: [CMVideoDimensions]) -> CMVideoDimensions? {
        let usable = supported.filter { $0.width > 0 && $0.height > 0 }
        guard !usable.isEmpty else { return nil }
        switch setting {
        case .max:
            return best(usable, preferLarger: true)
        case .twelveMP:
            let under = usable.filter { pixels($0) <= twelveMegapixelCap }
            if !under.isEmpty { return best(under, preferLarger: true) }
            return best(usable, preferLarger: false)
        }
    }

    static func largest(_ supported: [CMVideoDimensions]) -> CMVideoDimensions? {
        best(supported.filter { $0.width > 0 && $0.height > 0 }, preferLarger: true)
    }

    static func pixels(_ d: CMVideoDimensions) -> Int {
        Int(d.width) * Int(d.height)
    }

    /// First wins on a pixel-count tie, so the choice does not depend on list order flips of equals.
    private static func best(_ items: [CMVideoDimensions], preferLarger: Bool) -> CMVideoDimensions? {
        items.reduce(nil as CMVideoDimensions?) { best, next in
            guard let best else { return next }
            let pb = pixels(best)
            let pn = pixels(next)
            if pn == pb { return best }
            if preferLarger { return pn > pb ? next : best }
            return pn < pb ? next : best
        }
    }

    #if DEBUG
    static func runContractChecks() {
        func dim(_ w: Int32, _ h: Int32) -> CMVideoDimensions { CMVideoDimensions(width: w, height: h) }
        let twelve = dim(4032, 3024)
        let eight = dim(3264, 2448)
        let fortyEight = dim(8064, 6048)
        precondition(pixels(twelve) <= twelveMegapixelCap)
        precondition(pixels(fortyEight) > twelveMegapixelCap)

        let phone = [fortyEight, twelve, eight]
        precondition(choose(.twelveMP, supported: phone).map(pixels) == pixels(twelve))
        precondition(choose(.max, supported: phone).map(pixels) == pixels(fortyEight))
        precondition(choose(.twelveMP, supported: [eight]).map(pixels) == pixels(eight))
        precondition(choose(.twelveMP, supported: [fortyEight, dim(5712, 4284)]).map(pixels) == pixels(dim(5712, 4284)))
        precondition(choose(.max, supported: [twelve, fortyEight]).map(pixels) == pixels(fortyEight))
        precondition(choose(.twelveMP, supported: []) == nil)
        precondition(choose(.max, supported: [dim(0, 100), dim(-1, 5)]) == nil)
        precondition(choose(.max, supported: [twelve, twelve]).map { "\($0.width)x\($0.height)" } == "4032x3024")
        precondition(resolved(nil) == .twelveMP)
        precondition(resolved("max") == .max)
        precondition(resolved("nope") == .twelveMP)
    }
    #endif
}

/// What was asked of the camera for this still, for the `camera` metadata group.
struct PhotoSizeFacts {
    var setting: String
    var requestedWidth: Int?
    var requestedHeight: Int?
    var maxPhotoWidth: Int?
    var maxPhotoHeight: Int?
    var supported: [String]

    func cameraFields() -> [String: Any] {
        var out: [String: Any] = ["photoSizeSetting": setting]
        if let requestedWidth { out["requestedWidth"] = requestedWidth }
        if let requestedHeight { out["requestedHeight"] = requestedHeight }
        if let maxPhotoWidth { out["maxPhotoWidth"] = maxPhotoWidth }
        if let maxPhotoHeight { out["maxPhotoHeight"] = maxPhotoHeight }
        if !supported.isEmpty { out["supportedMaxPhotoDimensions"] = Array(supported.prefix(16)) }
        return out
    }
}
