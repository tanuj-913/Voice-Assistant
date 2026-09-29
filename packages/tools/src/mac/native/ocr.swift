// Text recognition using the Vision framework, which every Mac already has.
//
// The README notes that `capture_screen` returns a path a text-only model
// cannot see, and that making it useful needs either a vision model or an OCR
// pass. This is the OCR pass: no download, no API, no second model resident,
// and it works offline.
//
// Prints one recognised line per line of output. Exits non-zero with a message
// on stderr if the image cannot be read, so the caller can tell "no text
// found" from "that was not an image".
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: ocr <image-path>\n".data(using: .utf8)!)
    exit(2)
}

let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("could not read an image at \(path)\n".data(using: .utf8)!)
    exit(1)
}

let request = VNRecognizeTextRequest()
// Accurate over fast: this runs once on a screenshot, not per frame, and the
// difference on UI text is the difference between useful and noise.
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

do {
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write("recognition failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
