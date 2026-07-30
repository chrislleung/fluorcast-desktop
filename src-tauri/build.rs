fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release") && cfg!(windows) {
        let resource_dir = std::path::Path::new("resources").join("putty");
        let missing: Vec<&str> = ["putty.exe", "plink.exe", "pscp.exe"]
            .into_iter()
            .filter(|name| !resource_dir.join(name).is_file())
            .collect();
        if !missing.is_empty() {
            panic!(
                "Missing packaged PuTTY resources for release build: {}. Run scripts/prepare-putty-resources.ps1 before packaging.",
                missing.join(", ")
            );
        }
    }
    tauri_build::build()
}
