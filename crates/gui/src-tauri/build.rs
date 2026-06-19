fn main() {
    println!("cargo:rerun-if-env-changed=VERTEBRAE_BUNDLE_SIDECARS");

    if std::env::var_os("VERTEBRAE_BUNDLE_SIDECARS").is_none() {
        std::env::set_var("TAURI_CONFIG", r#"{"bundle":{"externalBin":[]}}"#);
    }

    tauri_build::build()
}
