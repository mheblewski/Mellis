import SwiftUI
import WebKit
import PDFKit
import GlucoMindCore

/// "Raport dla poradni" (clinic-report.v1, family): the server's four A4 pages shown as they will print, and "Udostępnij
/// PDF" — each page captured from a page-sized web view and joined into one PDF for the share sheet.
@MainActor
final class ClinicReportModel: ObservableObject {
    enum State { case loading, ready(String), failed }
    @Published var state: State = .loading
    @Published var pdfURL: URL?
    @Published var isMakingPDF = false
    @Published var pdfFailed = false
    let apiClient: APIClient
    let patientID: String

    init(apiClient: APIClient, patientID: String) {
        self.apiClient = apiClient
        self.patientID = patientID
    }

    func load() async {
        do {
            let html = try await apiClient.clinicReport(patientID: patientID)
            state = .ready(html)
            await makePDF(html)
        } catch {
            state = .failed
        }
    }

    func makePDF(_ html: String) async {
        isMakingPDF = true
        defer { isMakingPDF = false }
        do {
            let data = try await ClinicReportPDF.make(html: html, pages: 4)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("Raport dla poradni.pdf")
            try data.write(to: url, options: .atomic)
            pdfURL = url
            pdfFailed = false
        } catch {
            pdfFailed = true
        }
    }
}

/// Prints the report's fixed A4 sections (210 × 297 mm = 793,7 × 1122,5 CSS px) one by one.
@MainActor
enum ClinicReportPDF {
    static let pageWidth: CGFloat = 793.7
    static let pageHeight: CGFloat = 1122.52

    static func make(html: String, pages: Int) async throws -> Data {
        let configuration = WKWebViewConfiguration()
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight * CGFloat(pages)), configuration: configuration)
        web.isOpaque = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        // A web view lays out only inside a window: an invisible one, off the user's screen.
        let window = UIWindow(frame: web.frame)
        window.isHidden = false
        window.alpha = 0.01
        window.windowLevel = .normal - 1
        window.addSubview(web)
        defer { web.removeFromSuperview(); window.isHidden = true }
        let loader = Loader()
        web.navigationDelegate = loader
        web.loadHTMLString(html, baseURL: nil)
        try await loader.finished()
        // Fonts and SVG settle after the load event.
        try await Task.sleep(nanoseconds: 300_000_000)
        let document = PDFDocument()
        for index in 0..<pages {
            let config = WKPDFConfiguration()
            config.rect = CGRect(x: 0, y: pageHeight * CGFloat(index), width: pageWidth, height: pageHeight)
            let data = try await web.pdf(configuration: config)
            guard let page = PDFDocument(data: data)?.page(at: 0) else { throw CocoaError(.fileWriteUnknown) }
            document.insert(page, at: document.pageCount)
        }
        guard let data = document.dataRepresentation() else { throw CocoaError(.fileWriteUnknown) }
        return data
    }

    private final class Loader: NSObject, WKNavigationDelegate {
        private var continuation: CheckedContinuation<Void, Error>?
        private var done: Result<Void, Error>?

        func finished() async throws {
            if let done { return try done.get() }
            try await withCheckedThrowingContinuation { self.continuation = $0 }
        }

        private func finish(_ result: Result<Void, Error>) {
            if done != nil { return }
            done = result
            continuation?.resume(with: result)
            continuation = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(.success(())) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    }
}

/// The pages as they print: the HTML in a web view zoomed to the screen's width.
private struct ClinicReportPreview: UIViewRepresentable {
    let html: String

    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView()
        web.backgroundColor = .secondarySystemBackground
        web.isOpaque = false
        // Paper on a grey desk: white pages with a gap and a soft shadow (the PDF itself has none of this).
        let desk = "<style>html,body{background:#e9ecef!important}.page{background:#fff;margin:0 0 16px;box-shadow:0 1px 6px rgba(0,0,0,.18)}</style></head>"
        web.loadHTMLString(html.replacingOccurrences(of: "</head>", with: desk), baseURL: nil)
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct ClinicReportScreen: View {
    @StateObject private var model: ClinicReportModel
    @Environment(\.dismiss) private var dismiss

    init(apiClient: APIClient, patientID: String) {
        _model = StateObject(wrappedValue: ClinicReportModel(apiClient: apiClient, patientID: patientID))
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.state {
                case .loading:
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Przygotowuję raport z ostatnich 14 dni…").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed:
                    VStack(spacing: 12) {
                        Text("Nie udało się przygotować raportu.").foregroundStyle(.secondary)
                        Button("Spróbuj ponownie") { model.state = .loading; Task { await model.load() } }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .ready(let html):
                    ClinicReportPreview(html: html).ignoresSafeArea(edges: .bottom)
                }
            }
            .navigationTitle("Raport dla poradni")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Zamknij")
                }
                ToolbarItem(placement: .primaryAction) {
                    if let url = model.pdfURL {
                        ShareLink(item: url, preview: SharePreview("Raport dla poradni")) {
                            Label("Udostępnij PDF", systemImage: "square.and.arrow.up")
                        }
                        .accessibilityIdentifier("clinicReport.share")
                    } else if model.isMakingPDF {
                        ProgressView()
                    } else if model.pdfFailed, case .ready(let html) = model.state {
                        Button("Spróbuj PDF ponownie") { Task { await model.makePDF(html) } }
                    }
                }
            }
        }
        .task { await model.load() }
    }
}
