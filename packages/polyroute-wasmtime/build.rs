fn main() {
    napi_build::setup();
    println!(
        "cargo:rustc-env=POLYROUTE_TARGET={}",
        std::env::var("TARGET").expect("cargo sets TARGET for build scripts")
    );
    // A `.cwasm` loads only in the wasmtime version that wrote it, so the
    // version is read from the exact pin in Cargo.toml instead of repeated.
    println!("cargo:rerun-if-changed=Cargo.toml");
    let manifest = std::fs::read_to_string("Cargo.toml").expect("Cargo.toml is readable");
    let version = manifest
        .lines()
        .find_map(|line| {
            let rest = line.strip_prefix("wasmtime = ")?;
            let start = rest.find("\"=")? + 2;
            let end = start + rest[start..].find('"')?;
            Some(rest[start..end].to_string())
        })
        .expect("Cargo.toml pins wasmtime with an exact `=x.y.z` version");
    println!("cargo:rustc-env=POLYROUTE_WASMTIME_VERSION={version}");
}
