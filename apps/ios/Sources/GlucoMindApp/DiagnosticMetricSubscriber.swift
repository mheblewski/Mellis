import Foundation
import GlucoMindCore
#if canImport(MetricKit) && os(iOS)
import MetricKit

/// Crashes and hangs the system reports for this app, on this phone only. They arrive at a later launch and go into the
/// diagnostic log; nothing leaves the phone until the person shares a report. Stack traces are left out: every family
/// builds the app itself, so their addresses mean nothing without that build's symbols.
final class DiagnosticMetricSubscriber: NSObject, MXMetricManagerSubscriber {
    static let shared = DiagnosticMetricSubscriber()

    func start() {
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                DiagnosticLog.shared.record(.crash, "app_crashed", [
                    "exception_type": crash.exceptionType.map { "\($0)" } ?? "none",
                    "exception_code": crash.exceptionCode.map { "\($0)" } ?? "none",
                    "signal": crash.signal.map { "\($0)" } ?? "none",
                    "reason": crash.terminationReason.map(DiagnosticSanitizer.slug) ?? "none",
                    "version": DiagnosticSanitizer.slug(crash.applicationVersion),
                ])
            }
            for hang in payload.hangDiagnostics ?? [] {
                let seconds = Int(hang.hangDuration.converted(to: .seconds).value.rounded())
                DiagnosticLog.shared.record(.crash, "app_hang", ["seconds": "\(seconds)", "version": DiagnosticSanitizer.slug(hang.applicationVersion)])
            }
        }
    }
}
#endif
