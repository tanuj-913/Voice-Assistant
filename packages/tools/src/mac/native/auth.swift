// Platform authentication — Touch ID, with the login password as the fallback
// macOS itself offers.
//
// The PRD's `critical` tier asks for "strong confirmation; platform
// authentication where available". Approving in Assistant's own window is not
// that: the window is drawn by the process asking for permission. This asks
// the operating system instead, and the answer cannot be faked from inside the
// app.
//
// `.deviceOwnerAuthentication` rather than `.deviceOwnerAuthenticationWithBiometrics`
// on purpose: the second one fails outright on a Mac without Touch ID or with
// a wet finger, and an assistant that cannot be authorised at all is worse
// than one that asks for a password.
import Foundation
import LocalAuthentication

let reason = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "authorise this action"

let context = LAContext()
context.localizedCancelTitle = "Cancel"

var probeError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &probeError) else {
    // Distinguished from a refusal: nothing was asked, so nothing was denied.
    FileHandle.standardError.write(
        "unavailable: \(probeError?.localizedDescription ?? "no authentication method")\n"
            .data(using: .utf8)!)
    exit(2)
}

let waiter = DispatchSemaphore(value: 0)
var authorised = false
var failure = ""

context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
    authorised = ok
    if let error { failure = error.localizedDescription }
    waiter.signal()
}

// The callback arrives on a background queue; without this the process exits
// before the user has finished looking at the prompt.
waiter.wait()

if authorised {
    print("authorised")
    exit(0)
}
FileHandle.standardError.write("denied: \(failure)\n".data(using: .utf8)!)
exit(1)
