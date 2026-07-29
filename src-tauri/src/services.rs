// The Services menu reaches apps a global hotkey cannot, and needs no
// combination to configure. macOS hands us the pasteboard directly, so unlike
// the hotkey path there is no clipboard to protect and no keystroke to
// synthesise — which also means it needs no Accessibility permission.

#![cfg(target_os = "macos")]

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_app_kit::{NSApplication, NSPasteboard, NSPasteboardTypeString};
use objc2_foundation::{MainThreadMarker, NSArray, NSObject, NSObjectProtocol, NSString};

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "ChirpServiceProvider"]
    pub struct ServiceProvider;

    unsafe impl NSObjectProtocol for ServiceProvider {}

    impl ServiceProvider {
        // The selector is fixed by NSServices: the NSMessage value in
        // Info.plist with ":userData:error:" appended. Renaming one without
        // the other silently stops the menu item working.
        #[unsafe(method(speakWithChirp:userData:error:))]
        fn speak_with_chirp(
            &self,
            pboard: &NSPasteboard,
            _user_data: *mut NSString,
            _error: *mut *mut NSString,
        ) {
            let Some(text) = (unsafe { pboard.stringForType(NSPasteboardTypeString) }) else {
                return;
            };
            let text = text.to_string();
            if text.trim().is_empty() {
                return;
            }
            std::thread::spawn(move || {
                let _ = ureq::post(format!("{}/api/speak", crate::base_url()))
                    .send_json(serde_json::json!({ "text": text }));
            });
        }
    }
);

pub fn register() {
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("chirp: services must be registered on the main thread");
        return;
    };
    let provider: Retained<ServiceProvider> = unsafe { msg_send![ServiceProvider::alloc(), init] };
    let app = NSApplication::sharedApplication(mtm);
    unsafe {
        app.setServicesProvider(Some(&*provider as &AnyObject));
        NSApplication::registerServicesMenuSendTypes_returnTypes(
            &app,
            &NSArray::from_slice(&[NSPasteboardTypeString]),
            &NSArray::new(),
        );
    }
    // macOS keeps only an unowned reference to the services provider, so it
    // must outlive this function — for the app's whole lifetime.
    std::mem::forget(provider);
    eprintln!("chirp: services provider registered");
}
