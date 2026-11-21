import AppKit
import Foundation
import PDFKit
import Vision

let arguments = CommandLine.arguments
guard arguments.count == 3,
      let document = PDFDocument(url: URL(fileURLWithPath: arguments[1])) else {
    FileHandle.standardError.write(Data("需要有效的 PDF 路径与页码列表\n".utf8))
    exit(2)
}

var pages: [Int: String] = [:]
do {
    for item in arguments[2].split(separator: ",") {
        guard let number = Int(item), (1...document.pageCount).contains(number),
              let page = document.page(at: number - 1) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let size = page.bounds(for: .mediaBox).size
        let scale = 2100 / max(size.width, size.height)
        let thumbnail = page.thumbnail(
            of: CGSize(width: size.width * scale, height: size.height * scale),
            for: .mediaBox
        )
        var bounds = CGRect(origin: .zero, size: thumbnail.size)
        guard let image = thumbnail.cgImage(forProposedRect: &bounds, context: nil, hints: nil) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        try VNImageRequestHandler(cgImage: image).perform([request])
        pages[number] = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
    try FileHandle.standardOutput.write(contentsOf: JSONEncoder().encode(pages))
} catch {
    FileHandle.standardError.write(Data(("扫描页 OCR 失败：" + error.localizedDescription + "\n").utf8))
    exit(1)
}
