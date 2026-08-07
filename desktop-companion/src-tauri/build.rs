fn main() {
    // CI proof that features/cfgs actually reached the Rust build, rather than
    // just appearing in a command string. These surface as `warning:` lines in
    // the cargo build log and are grepped by the Windows CI workflow.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_else(|_| "unknown".into());
    println!("cargo:warning=COMPANION_BUILD target_os={target_os}");

    let backend = match target_os.as_str() {
        "windows" => "wasapi",
        "macos" => "screencapturekit",
        _ => "unsupported",
    };
    println!("cargo:warning=COMPANION_BUILD capture_backend={backend}");

    if std::env::var_os("CARGO_FEATURE_DEV_DIAGNOSTICS").is_some() {
        println!("cargo:warning=COMPANION_BUILD feature_dev_diagnostics=enabled");
    } else {
        println!("cargo:warning=COMPANION_BUILD feature_dev_diagnostics=disabled");
    }

    if std::env::var_os("CARGO_FEATURE_REQUIRE_NATIVE_BACKEND").is_some() {
        println!("cargo:warning=COMPANION_BUILD feature_require_native_backend=enabled");
    }

    tauri_build::build()
}
