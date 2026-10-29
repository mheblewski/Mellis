// Extracts the text of a PDF with macOS PDFKit, one form feed between pages (used by rag-corpus-ingest.ts).
// Usage: rag-pdf-text <in.pdf> <out.txt>
import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count == 3, let document = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
  FileHandle.standardError.write("usage: rag-pdf-text <in.pdf> <out.txt>\n".data(using: .utf8)!)
  exit(1)
}
var pages: [String] = []
for index in 0..<document.pageCount {
  pages.append(document.page(at: index)?.string ?? "")
}
do {
  try pages.joined(separator: "\u{0C}").write(toFile: args[2], atomically: true, encoding: .utf8)
} catch {
  FileHandle.standardError.write("cannot write output\n".data(using: .utf8)!)
  exit(1)
}
print("pages: \(document.pageCount)")
