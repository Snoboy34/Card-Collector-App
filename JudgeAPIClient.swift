import Foundation

/// Multipart client for the existing Node `POST /api/grade` route.
/// Base URL is user-configured (LAN IP changes). Self-signed LAN certs are
/// accepted only for loopback / RFC1918 / `.local` hosts — the same trust
/// decision Safari already requires on `npm run start:lan`.
final class JudgeAPIClient: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    static let shared = JudgeAPIClient()
    static let serverURLDefaultsKey = "judgeServerBaseURL"

    struct TiltSnapshot {
        var pitchDeg: Double
        var rollDeg: Double
        var isLevel: Bool
    }

    struct RemoteReport {
        var ok: Bool
        var finalScore: Double?
        var subGradesLabel: String?
        var primaryFlaw: String?
        var incomplete: Bool?
        var hint: String?
        var interiorMean: Double?
        var bandVsInteriorMin: Double?
        var bandVsInteriorJSON: String?
        var alignmentCrop: Bool?
        var rawJSON: String
        var summaryText: String
    }

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    static func normalizedBaseURL(_ raw: String) -> URL? {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        guard !trimmed.isEmpty, let url = URL(string: trimmed), url.scheme == "http" || url.scheme == "https" else {
            return nil
        }
        return url
    }

    func grade(
        jpeg: Data,
        baseURL: String,
        name: String,
        cardType: String?,
        tilt: TiltSnapshot?
    ) async throws -> RemoteReport {
        guard let root = Self.normalizedBaseURL(baseURL) else {
            throw APIError.invalidServerURL
        }
        let endpoint = root.appendingPathComponent("api/grade")
        let boundary = "JudgeBoundary\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.multipartBody(
            boundary: boundary,
            jpeg: jpeg,
            name: name,
            cardType: cardType,
            tilt: tilt
        )

        let (data, response) = try await session.data(for: request)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? -1
        guard (200...299).contains(status) else {
            let snippet = String(data: data, encoding: .utf8) ?? "HTTP \(status)"
            throw APIError.httpFailure(status, snippet)
        }
        return try Self.parseReport(data)
    }

    enum APIError: LocalizedError {
        case invalidServerURL
        case httpFailure(Int, String)
        case undecodableResponse

        var errorDescription: String? {
            switch self {
            case .invalidServerURL:
                return "Set the Mac Judge URL first (https://<lan-ip>:5000)."
            case .httpFailure(let code, let body):
                return "Grade request failed (\(code)): \(body)"
            case .undecodableResponse:
                return "Server did not return JSON."
            }
        }
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let space = challenge.protectionSpace
        if space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = space.serverTrust,
           Self.isLANHost(space.host) {
            completionHandler(.useCredential, URLCredential(trust: trust))
            return
        }
        completionHandler(.performDefaultHandling, nil)
    }

    static func isLANHost(_ host: String) -> Bool {
        let lower = host.lowercased()
        if lower == "localhost" || lower == "127.0.0.1" || lower == "::1" { return true }
        if lower.hasSuffix(".local") { return true }
        if lower.hasPrefix("10.") || lower.hasPrefix("192.168.") || lower.hasPrefix("169.254.") { return true }
        let parts = lower.split(separator: ".")
        if parts.count == 4, parts[0] == "172", let second = Int(parts[1]), (16...31).contains(second) {
            return true
        }
        return false
    }

    private static func multipartBody(
        boundary: String,
        jpeg: Data,
        name: String,
        cardType: String?,
        tilt: TiltSnapshot?
    ) -> Data {
        var body = Data()
        func appendField(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"image\"; filename=\"native-still.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(jpeg)
        body.append("\r\n".data(using: .utf8)!)
        appendField("name", name)
        appendField("alignmentCrop", "true")
        appendField("debug", "true")
        appendField("captureMode", "native-still")
        if let cardType, !cardType.isEmpty {
            appendField("cardType", cardType)
        }
        if let tilt {
            appendField("capturePitch", String(format: "%.2f", tilt.pitchDeg))
            appendField("captureRoll", String(format: "%.2f", tilt.rollDeg))
            appendField("captureLevel", tilt.isLevel ? "true" : "false")
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        return body
    }

    private static func parseReport(_ data: Data) throws -> RemoteReport {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.undecodableResponse
        }
        let raw = String(data: data, encoding: .utf8) ?? "{}"
        let item = root["item"] as? [String: Any]
        let report = (item?["gradingReport"] as? [String: Any]) ?? (root["report"] as? [String: Any])
        let diagnostics = report?["centeringDiagnostics"] as? [String: Any]
        let band = diagnostics?["bandVsInterior"] as? [String: Any]
        let interior = band?["interior"] as? [String: Any]
        let bandJSON: String?
        if let band, let encoded = try? JSONSerialization.data(withJSONObject: band, options: [.sortedKeys]),
           let text = String(data: encoded, encoding: .utf8) {
            bandJSON = text
        } else {
            bandJSON = nil
        }

        let finalScore = doubleValue(report?["finalScore"])
        let incomplete = (boolValue(report?["incomplete"]) ?? false) || (boolValue(report?["centeringUndetected"]) ?? false)
        let interiorMean = doubleValue(interior?["mean"]) ?? doubleValue(diagnostics?["interiorMean"])
        let bandMin = doubleValue(band?["min"]) ?? doubleValue(diagnostics?["bandVsInteriorMin"])
        let hint = diagnostics?["hint"] as? String
        let sub = report?["subGradesLabel"] as? String
        let flaw = report?["primaryFlawDescription"] as? String
        let alignmentCrop = (boolValue(diagnostics?["alignmentCrop"]) ?? false) || (boolValue(report?["alignmentCrop"]) ?? false)

        var lines: [String] = []
        if let finalScore { lines.append(String(format: "finalScore  %.1f", finalScore)) }
        if incomplete { lines.append("incomplete  true") }
        if let sub { lines.append(sub) }
        if let flaw { lines.append(flaw) }
        if let hint { lines.append("hint  \(hint)") }
        if let interiorMean { lines.append(String(format: "interiorMean  %.2f", interiorMean)) }
        if let bandMin { lines.append(String(format: "bandVsInteriorMin  %.3f", bandMin)) }
        if let bandJSON { lines.append("bandVsInterior  \(bandJSON)") }
        if alignmentCrop == true { lines.append("alignmentCrop  true") }
        if lines.isEmpty { lines.append(raw) }

        return RemoteReport(
            ok: boolValue(root["ok"]) ?? false,
            finalScore: finalScore,
            subGradesLabel: sub,
            primaryFlaw: flaw,
            incomplete: incomplete,
            hint: hint,
            interiorMean: interiorMean,
            bandVsInteriorMin: bandMin,
            bandVsInteriorJSON: bandJSON,
            alignmentCrop: alignmentCrop,
            rawJSON: raw,
            summaryText: lines.joined(separator: "\n")
        )
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        if let n = value as? NSNumber { return n.doubleValue }
        if let s = value as? String { return Double(s) }
        return nil
    }

    private static func boolValue(_ value: Any?) -> Bool? {
        if let b = value as? Bool { return b }
        if let n = value as? NSNumber { return n.boolValue }
        if let s = value as? String {
            return s == "true" || s == "1"
        }
        return nil
    }
}
