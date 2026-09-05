import Cocoa
import WebKit

// Dedicated test host: the same native WKWebView engine used by macOS Tauri.
// It loads only the local production-built fixture and never connects to Sacrum.
class Host: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webview: WKWebView!
    @objc func reload() { webview.reload() }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1200, height: 850), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Markdown WKWebView Verification"
        webview = WKWebView(frame: window.contentView!.bounds)
        webview.autoresizingMask = [.width, .height]
        window.contentView!.addSubview(webview)
        webview.load(URLRequest(url: URL(string: "http://127.0.0.1:18420/perf/markdown-streaming.html")!))
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let actions = NSMenu()
        let reloadItem = NSMenuItem(title: "Reload fixture", action: #selector(reload), keyEquivalent: "r")
        reloadItem.target = self
        actions.addItem(reloadItem)
        actions.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = actions
        NSApp.mainMenu = menu
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
let app = NSApplication.shared
let host = Host()
app.delegate = host
app.setActivationPolicy(.regular)
app.run()
